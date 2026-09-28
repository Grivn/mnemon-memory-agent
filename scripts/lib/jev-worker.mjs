import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Each process keeps only the keys it uses: JEV for the replica, and the providers of its own models (if any). */
function keysFor(role, models) {
  const used = models.filter(Boolean), openai = used.some(model => /^(gpt-|o\d)/.test(model)) // isOpenAIModel in openai.ts
  return { ...(role === 'main' ? { TYPESAFE_API_KEY: '' } : {}), ...(!used.some(model => !/^(gpt-|o\d)/.test(model)) ? { DEEPSEEK_API_KEY: '' } : {}), ...(!openai ? { OPENAI_API_KEY: '' } : {}) }
}

/** Real process isolation, bounded IPC waits, and teardown owned by the caller. */
export async function startWorker(root, role, { live = false, noReplica = false, capture = true, fullContext = false, complex = false, wide = false, optmem = false, flat = false, maintained = false, skipMaintenance = false, boundedCold = false, localNap = false, backgroundMs = 0, corpusRoot, waitMs = 15000, study, lexical = false, natural, delivery, snapshots, naturalCorpus = false, maxRevisionLag = 0, recall, mainMemory = false, thinking = false, gate, termsFrom, bench, fill, intent = false, focus, materialize = false, mainModel, recallModel, searches, briefPlan = false, datesFirst = false, embedUrl, loop, loopFill, worth, unsureFill, feedback = false, simple = false, auto = false, consolidate, largeJournal = false, onLog = () => {} } = {}) {
  const child = fork(fileURLToPath(new URL('../jev-replica-worker.ts', import.meta.url)), ['--root', root, '--role', role, '--wait', String(waitMs), ...live ? ['--live'] : [], ...noReplica ? ['--no-replica'] : [], ...capture ? [] : ['--no-capture'], ...fullContext ? ['--full-context'] : [], ...complex ? ['--complex'] : [], ...wide ? ['--wide'] : [], ...optmem ? ['--optmem'] : [], ...flat ? ['--flat'] : [], ...maintained ? ['--maintained'] : [], ...skipMaintenance ? ['--no-nap'] : [], ...boundedCold ? ['--bounded-cold'] : [], ...localNap ? ['--local-nap'] : [], ...study ? ['--study', study] : [], ...lexical ? ['--lexical'] : [], ...natural ? ['--natural', natural] : [], ...delivery ? ['--delivery', delivery] : [], ...snapshots ? ['--snapshots', snapshots] : [], ...naturalCorpus ? ['--natural-corpus'] : [], ...recall ? ['--recall', recall] : [], ...mainMemory ? ['--main-memory'] : [], ...thinking ? ['--thinking'] : [], ...gate !== undefined ? ['--gate', String(gate)] : [], ...termsFrom ? ['--terms-from', termsFrom] : [], ...bench ? ['--bench', bench] : [], ...fill !== undefined ? ['--fill', String(fill)] : [], ...intent ? ['--intent'] : [], ...focus !== undefined ? ['--focus', String(focus)] : [], ...materialize ? ['--materialize'] : [], ...mainModel ? ['--main-model', mainModel] : [], ...recallModel ? ['--recall-model', recallModel] : [], ...searches ? ['--searches', String(searches)] : [], ...briefPlan ? ['--brief-plan'] : [], ...datesFirst ? ['--dates-first'] : [], ...embedUrl ? ['--embed-url', embedUrl] : [], ...loop ? ['--loop', String(loop)] : [], ...loopFill ? ['--loop-fill', String(loopFill)] : [], ...worth ? ['--worth', String(worth)] : [], ...unsureFill ? ['--unsure-fill', String(unsureFill)] : [], ...feedback ? ['--feedback'] : [], ...simple ? ['--simple'] : [], ...auto ? ['--auto'] : [], ...consolidate ? ['--consolidate', consolidate] : [], ...largeJournal ? ['--large-journal'] : [], '--lag', String(maxRevisionLag), '--background', String(backgroundMs), ...corpusRoot ? ['--corpus-root', corpusRoot] : []], {
    execArgv: ['--experimental-transform-types', '--disable-warning=ExperimentalWarning'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, ...keysFor(role, role === 'main' ? [mainModel ?? 'deepseek-flash'] : [recall === 'llm' || recall === 'cue' ? recallModel ?? 'deepseek-flash' : undefined, consolidate]) },
  })
  child.stdout.on('data', bytes => onLog(String(bytes))); child.stderr.on('data', bytes => onLog(String(bytes)))
  const pending = new Map(); let counter = 0
  const ready = Promise.withResolvers()
  const timer = setTimeout(() => ready.reject(new Error('DSH worker startup timed out')), 30000)
  child.on('message', message => {
    if (message.ready) { clearTimeout(timer); ready.resolve(message); return }
    const item = pending.get(message.id)
    if (item) { clearTimeout(item.timer); pending.delete(message.id); message.error ? item.reject(new Error(message.error)) : item.resolve(message.value) }
  })
  child.on('exit', (code, signal) => {
    clearTimeout(timer); const error = new Error(`${role} worker exited (${code ?? signal})`); ready.reject(error)
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error) }; pending.clear()
  })
  child.on('error', error => ready.reject(error))
  let info
  try { info = await ready.promise } catch (error) { child.kill('SIGTERM'); throw error }
  const request = (method, args = {}, timeoutMs = 60000) => new Promise((resolve, reject) => {
    const id = String(++counter), timer = setTimeout(() => { pending.delete(id); reject(new Error(`${role}.${method} timed out`)) }, timeoutMs)
    pending.set(id, { resolve, reject, timer }); child.send({ id, method, args })
  })
  return { info, request, async close() {
    if (child.exitCode !== null || child.signalCode) return
    try { await request('close', {}, 15000) } finally { child.disconnect(); const killed = setTimeout(() => child.kill('SIGKILL'), 5000); killed.unref(); child.once('exit', () => clearTimeout(killed)) }
  } }
}
