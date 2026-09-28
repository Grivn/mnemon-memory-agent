import { Context } from '@deepseek-ai/cordis'
import { Config as PlainConfig, InteractionConfig, resolveConfig, resolveInteractionConfig, type Config as MnemonConfig } from './config.ts'
import { registerCommands } from './commands.ts'
import type { HostContextShape, HostWorkspaceRegistry } from './dsh.ts'
import { registerGuidance } from './guidance.ts'
import { createRuntimeGraph, LiveMnemonRuntime, type MnemonRuntimeGraph } from './runtime.ts'
import { MnemonLifecycle } from './lifecycle.ts'
import { registerRpc } from './rpc.ts'
import { migrateLegacyDisplayMode, registerSettingsRpc } from './settings.ts'
import { MnemonSubagentCoordinator } from './subagent.ts'
import { registerTools } from './tools.ts'
import { registerMnemonSubagentTokenUsageProjection } from './subagent-token-usage.ts'
import { provideMemoryRuntime } from '../core/runtime.ts'
import { MemoryPluginManagement } from './plugin-management.ts'
import { registerViewRpc } from './view-rpc.ts'
import { MemoryPluginInstallation } from './plugin-installation.ts'
import { MnemonRemoteService } from './remote-rpc.ts'
import { plainHostConfig, type LiveHostConfig } from './live-config.ts'
import { createHostSettings, ProfileMnemonSettings, subscribeSettings } from './settings-service.ts'

export const name = 'dsh-mnemon'
export const provide = ['mnemonMemory']
export const inject = ['tools', 'settings', 'commands', 'agents', 'subagents']
export { LiveConfig as Config } from './live-config.ts'
export type { MnemonConfig }

/** Resolve the optional Web workspace service at call time, not plugin-mount time. */
function optionalWorkspaceRegistry(ctx: HostContextShape): HostWorkspaceRegistry {
  const current = (): HostWorkspaceRegistry | undefined => ctx.get('workspaceRegistry') as HostWorkspaceRegistry | undefined
  return {
    get: id => current()?.get(id),
    list: () => current()?.list() ?? [],
  }
}

/** DSH owns assembly; this Host only wires scope, phases and user preferences. */
export function apply(rawContext: unknown, rawConfig: MnemonConfig | LiveHostConfig = {}): void {
  const ctx = rawContext as unknown as HostContextShape
  const config = plainHostConfig(rawConfig)
  const hostSettings = createHostSettings(ctx, rawConfig)
  registerMnemonSubagentTokenUsageProjection(ctx)
  const extensions = provideMemoryRuntime(ctx)
  const memoryPlugins = new MemoryPluginManagement(ctx, extensions, hostSettings)
  const pluginInstallation = new MemoryPluginInstallation(ctx)
  const effectiveConfig = (value: MnemonConfig) => memoryPlugins.resolveConfig(resolveConfig(value),
    hostSettings instanceof ProfileMnemonSettings ? value.memoryView ?? { entries: {} } : undefined)
  const prepared = new Map<object, { graph: MnemonRuntimeGraph; token: symbol }>()
  const disposePrepared = (): void => {
    for (const candidate of prepared.values()) candidate.graph.dispose()
    prepared.clear()
  }
  const settings = hostSettings.register<MnemonConfig>('mnemon', PlainConfig, {
    base: config,
    applies: 'live',
    validate: value => {
      disposePrepared()
      const candidate = { graph: createRuntimeGraph(effectiveConfig(value), undefined, extensions), token: Symbol('prepared-runtime') }
      // Profile writes are asynchronous. Check the candidate now, then build
      // from the committed live references when DSH emits volatile-update.
      if (hostSettings instanceof ProfileMnemonSettings) {
        candidate.graph.dispose()
        return
      }
      prepared.set(value, candidate)
      // Legacy Settings commits synchronously after validation. A standalone/cancelled
      // validation has no commit event, so retire its attached graph next tick.
      queueMicrotask(() => {
        if (prepared.get(value)?.token !== candidate.token) return
        prepared.delete(value)
        candidate.graph.dispose()
      })
    },
  })
  const initialSettings = settings.get()
  const initialCandidate = prepared.get(initialSettings)
  if (initialCandidate !== undefined) prepared.delete(initialSettings)
  const runtime = new LiveMnemonRuntime(initialCandidate?.graph ?? createRuntimeGraph(effectiveConfig(initialSettings), undefined, extensions), optionalWorkspaceRegistry(ctx), ctx.agents, extensions)
  const resolved = runtime.config
  ctx.effect(() => subscribeSettings(ctx, hostSettings, (namespace: string, value: unknown) => {
    const next = value as MnemonConfig
    if (namespace === memoryPlugins.settingsNamespace) {
      runtime.swap(createRuntimeGraph(effectiveConfig(settings.get()), undefined, extensions))
      return
    }
    if (namespace !== 'mnemon') return
    const candidate = prepared.get(next)
    if (candidate !== undefined) prepared.delete(next)
    disposePrepared()
    runtime.swap(candidate?.graph ?? createRuntimeGraph(effectiveConfig(next), undefined, extensions))
  }), 'dsh-mnemon: live runtime settings')
  ctx.effect(() => memoryPlugins.start(), 'dsh-mnemon: plugin graph settings')
  hostSettings.register('mnemon-ui', InteractionConfig, {
    base: resolveInteractionConfig(resolved.conversationInteraction),
    applies: 'live',
  })
  ctx.effect(() => {
    let disposed = false
    const migrate = (): void => {
      if (disposed) return
      void migrateLegacyDisplayMode(hostSettings).catch(error => {
        console.warn('dsh-mnemon: could not persist the builtin displayMode migration', error)
      })
    }
    const unsubscribe = ctx.on('settings/document-updated', ((namespace: string) => {
      if (namespace === 'mnemon') migrate()
    }) as never)
    migrate()
    return () => { disposed = true; unsubscribe() }
  }, 'dsh-mnemon: canonical displayMode migration')
  if (hostSettings instanceof ProfileMnemonSettings) {
    ctx.effect(() => {
      let disposed = false
      const loader = ctx.get('loader') as { await?(): Promise<unknown> } | undefined
      void Promise.resolve(loader?.await?.()).then(async () => {
        if (disposed) return
        const catalog = await memoryPlugins.catalog()
        if (disposed) return
        await hostSettings.importLegacy(catalog.entries.filter(entry => entry.roles.includes('source')).map(entry => entry.entryId))
      }).catch(error => { console.warn('dsh-mnemon: could not recover retained legacy settings', error) })
      return () => { disposed = true }
    }, 'dsh-mnemon: retained settings migration')
  }
  const coordinator: MnemonSubagentCoordinator = new MnemonSubagentCoordinator(ctx.subagents, runtime, ctx, () => {
    const taskAgentModel = runtime.config.taskAgentModel
    if (taskAgentModel.mode !== 'fixed') return undefined
    const provider = taskAgentModel.provider?.trim()
    const model = taskAgentModel.model?.trim()
    if (provider === undefined || provider === '' || model === undefined || model === '') return undefined
    return { provider, model }
  }, () => runtime.config.runtimeMemory.maintenanceMaxTokens,
  (scope, signal, operation) => lifecycle.runRuntimeMaintenanceTask(scope, signal, operation))
  const lifecycle = new MnemonLifecycle(ctx, coordinator, runtime.config, runtime)
  ctx.effect(() => {
    const stop = lifecycle.start()
    return async () => {
      stop()
      await coordinator.dispose()
      disposePrepared()
      runtime.dispose()
    }
  }, 'dsh-mnemon.lifecycle-root()')
  registerTools(ctx, runtime, coordinator)
  registerCommands(ctx.commands, runtime, coordinator)
  registerGuidance(ctx, resolved)
  ctx.inject(['connection'], (webContext) => {
    // `inject` guarantees the service at runtime; retain the defensive guard
    // because HostContextShape also models profiles where it is absent.
    if (webContext.connection === undefined) return
    // Keep one branch-free call shape across both supported DSH generations:
    // rc.2 enforces this legacy channel authority, while 0.1.2-alpha.1 ignores
    // the extra JavaScript argument and authenticates every Host API uniformly.
    const managementAuthority = resolved.remoteAccess === 'trusted-host' ? 'trusted-host' : 'loopback'
    const rpc = registerRpc(webContext.connection, runtime, lifecycle, undefined, managementAuthority)
    const settings = registerSettingsRpc(webContext.connection, hostSettings, managementAuthority)
    const view = registerViewRpc(webContext.connection, runtime, extensions, memoryPlugins, lifecycle, managementAuthority, pluginInstallation)
    if (Context.is(webContext)) {
      new MnemonRemoteService(webContext, {
        ...rpc,
        settings,
        view: view.read,
        viewWrite: view.write,
        management: managementAuthority === 'trusted-host',
      })
    }
  })
}
