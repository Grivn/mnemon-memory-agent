/** External read recipes. No plugin internals, storage files, or management APIs. */
export interface Route { id: string; sourceInstanceKey: string; sourceTypeId: string; operationId: string; description: string; maxCalls?: number; inputSchema?: unknown }
const property = (route: Route, name: string) => (route.inputSchema as { properties?: Record<string, { type?: string; enum?: unknown[] }> } | undefined)?.properties?.[name]
/** The Route's own schema offers this input property. */
export const accepts = (route: Route, name: string) => property(route, name) !== undefined
/** The Route's own schema says it can rank by any word of a query (`match: 'words'`) rather than only whole phrases. */
export const acceptsWords = (route: Route) => property(route, 'match')?.enum?.includes('words') === true
/** The Route's own schema says it can also rank by meaning and fuse that with its word ranking (`match: 'hybrid'`). */
export const acceptsHybrid = (route: Route) => property(route, 'match')?.enum?.includes('hybrid') === true
/** The Route's own schema says it can read several records by id in one call. */
export const acceptsIds = (route: Route) => property(route, 'ids')?.type === 'array'
export interface EvidenceItem { id: string; text: string; revision?: string; provenance?: Record<string, unknown> }
export interface Evidence { items?: EvidenceItem[]; revision?: string; truncated?: boolean; continuation?: { routeId: string; input: Record<string, unknown> }; metadata?: { expansion?: unknown } }
export interface Adapter {
  sourceTypeId: string
  operationId: string
  input?: Record<string, unknown>
  queryField?: string
  limitField?: string
  /** Extra input for cue searches. Without it, `{ match: 'words' }` is used wherever the Route's schema offers it. */
  cueInput?: Record<string, unknown>
  /** Optional direct reread contract, explicitly configured by the installer. */
  reread?: { operationId: string; bindings: Record<string, string>; input?: Record<string, unknown> }
  /** Query-independent initial browse. Missing means the ordinary recipe, except $term. */
  /** Only explicit complete enumeration contracts may retire absent navigation leaves. */
  exhaustive?: boolean
  maintainInput?: Record<string, unknown>
  /** Primary results are cards or paths (e.g. titles, file names); `expand` opens their bodies. */
  stubs?: boolean
  /**
   * Input field that bounds records by date, inclusive (e.g. `until`). A Source too large for one View is then
   * enumerated backwards in time across jobs: each job continues from the oldest date the previous one reached.
   */
  until?: string
  /** Declarative public Route used to open an observed child. */
  expand?: { operationId: string; bindings: Record<string, string>; input?: Record<string, unknown> }
}
export interface ReadPlan { route: Route; input: Record<string, unknown>; kind: 'wake' | 'recall' | 'zoom' | 'continue'; hint: string }
export const planKey = (plan: ReadPlan) => JSON.stringify([plan.route.id, plan.input])
function at(item: EvidenceItem, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, item)
}
/** Fill a configured Route input from an observed item; undefined when a binding is absent. */
export function bindInput(spec: { bindings: Record<string, string>; input?: Record<string, unknown> }, item: EvidenceItem): Record<string, unknown> | undefined {
  const input: Record<string, unknown> = { ...spec.input }
  for (const [name, path] of Object.entries(spec.bindings)) {
    const value = at(item, path)
    if (typeof value !== 'string' && typeof value !== 'number') return
    input[name] = value
  }
  return input
}
export function openChild(adapter: Adapter, from: Route, item: EvidenceItem, routes: Route[]): ReadPlan | undefined {
  if (!adapter.expand) return
  const route = routes.find(route => route.sourceInstanceKey === from.sourceInstanceKey && route.operationId === adapter.expand!.operationId)
  const input = route && bindInput(adapter.expand, item)
  return input ? { route: route!, input, kind: 'zoom', hint: item.text.slice(0, 350) } : undefined
}
