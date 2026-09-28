/** External acceptance runner; generated code has no imports, filesystem or credentials. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import vm from 'node:vm'
const [workspace, flag] = process.argv.slice(2), full = flag === '--full'
const checks = []
const add = (id, passed, actual) => checks.push({ id, passed: !!passed, ...(actual === undefined ? {} : { actual }) })
const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } })
vm.runInContext('globalThis.structuredClone = value => JSON.parse(JSON.stringify(value)); globalThis.console = { log() {}, warn() {} }', context)
let module
try {
  module = new vm.SourceTextModule(await readFile(join(workspace, 'outputs/domain.js'), 'utf8'), { context })
  await module.link(() => { throw new Error('Domain logic must have no external imports') })
  await module.evaluate({ timeout: 250 })
  context.api = module.namespace
  add('domain-loads', true)
} catch (error) { add('domain-loads', false, String(error)) }
const test = (id, code) => {
  if (!context.api) return add(id, false, 'Domain unavailable')
  try { add(id, vm.runInContext(`(() => { ${code} })()`, context, { timeout: 250 })) } catch (error) { add(id, false, String(error)) }
}
test('public-exports', "return ['createState','register','cancel','summary','publicRoster','exportState','importState','toCSV'].every(k=>typeof api[k]==='function')")
test('public-register', "const s=api.createState({capacity:2,feeCents:100}); const next=api.register(s,{id:'a',name:'甲',email:'a@example.test',consent:true},1); return next.registrations.some(r=>r.id==='a'&&r.status==='confirmed')")
test('public-summary', "const s=api.createState({capacity:2,feeCents:100}); const n=api.summary(s); return n.confirmed===0&&n.waiting===0&&n.cancelled===0&&n.revenueCents===0")
if (full) {
  test('current-defaults', 'const s=api.createState(); return s.capacity===4&&s.feeCents===1800')
  test('custom-config', 'const s=api.createState({capacity:2,feeCents:350}); return s.capacity===2&&s.feeCents===350')
  test('immutable-state', "const s=api.createState(); const before=JSON.stringify(s); const next=api.register(s,{id:'a',name:'甲',email:'a@example.test',consent:true},1); return next!==s&&JSON.stringify(s)===before")
  test('consent-required', "try{api.register(api.createState(),{id:'a',name:'甲',email:'a@example.test',consent:false},1);return false}catch{return true}")
  test('name-required', "try{api.register(api.createState(),{id:'a',name:'  ',email:'a@example.test',consent:true},1);return false}catch{return true}")
  test('email-valid', "try{api.register(api.createState(),{id:'a',name:'甲',email:'invalid',consent:true},1);return false}catch{return true}")
  test('idempotent-register', "const p={id:'a',name:'甲',email:'a@example.test',consent:true}; const s=api.register(api.createState(),p,1);return api.register(s,p,2).registrations.length===1")
  test('email-case-insensitive', "const s=api.register(api.createState(),{id:'a',name:'甲',email:'A@example.test',consent:true},1);try{api.register(s,{id:'b',name:'乙',email:'a@EXAMPLE.test',consent:true},2);return false}catch{return true}")
  const filled = "let s=api.createState({capacity:1,feeCents:1800});for(const [i,id] of ['a','b','c'].entries())s=api.register(s,{id,name:id,email:id+'@example.test',consent:true},i+1);"
  test('waiting-not-charged', filled + 'const n=api.summary(s);return n.confirmed===1&&n.waiting===2&&n.revenueCents===1800')
  test('fifo-promotion', filled + "const n=api.cancel(s,'a');return n.registrations.find(r=>r.id==='b').status==='confirmed'&&n.registrations.find(r=>r.id==='c').status==='waiting'&&n.registrations.find(r=>r.id==='a').status==='cancelled'")
  test('cancel-keeps-input', filled + "const before=JSON.stringify(s);api.cancel(s,'a');return before===JSON.stringify(s)")
  test('cancel-idempotent', filled + "const n=api.cancel(s,'a');return JSON.stringify(api.cancel(n,'a'))===JSON.stringify(n)")
  test('cancel-waiting', filled + "const n=api.cancel(s,'b');return n.registrations.find(r=>r.id==='a').status==='confirmed'&&n.registrations.find(r=>r.id==='c').status==='waiting'")
  test('cancelled-not-revived', filled + "const n=api.cancel(s,'a');const p={id:'a',name:'a',email:'a@example.test',consent:true};try{return api.register(n,p,9).registrations.find(r=>r.id==='a').status==='cancelled'}catch{return true}")
  test('cancelled-email-reusable', filled + "const n=api.cancel(s,'a');return api.register(n,{id:'d',name:'丁',email:'a@example.test',consent:true},9).registrations.some(r=>r.id==='d')")
  test('integer-revenue', filled + "const n=api.summary(api.cancel(s,'a'));return n.confirmed===1&&n.waiting===1&&n.cancelled===1&&n.revenueCents===1800")
  test('public-roster-private', filled + "const p=api.publicRoster(s);return Array.isArray(p)&&p.length>0&&!JSON.stringify(p).includes('@example.test')&&!JSON.stringify(p).includes('email')")
  test('backup-version-two', filled + 'const v=JSON.parse(api.exportState(s));return v.version===2&&Array.isArray(v.state?.registrations)')
  test('backup-roundtrip', filled + 'return JSON.stringify(api.importState(api.exportState(s)))===JSON.stringify(s)')
  test('reject-invalid-json', "try{api.importState('{bad');return false}catch{return true}")
  test('reject-unknown-version', "try{api.importState(JSON.stringify({version:99,state:api.createState()}));return false}catch{return true}")
  test('reject-negative-capacity', "try{api.importState(JSON.stringify({version:2,state:{...api.createState(),capacity:-1}}));return false}catch{return true}")
  test('reject-fractional-money', "try{api.importState(JSON.stringify({version:2,state:{...api.createState(),feeCents:10.5}}));return false}catch{return true}")
  test('reject-missing-records', "const s=api.createState();delete s.registrations;try{api.importState(JSON.stringify({version:2,state:s}));return false}catch{return true}")
  test('reject-invalid-status', filled + "s.registrations[0].status='mystery';try{api.importState(JSON.stringify({version:2,state:s}));return false}catch{return true}")
  test('csv-private', filled + "const csv=api.toCSV(s);return typeof csv==='string'&&!csv.includes('@example.test')")
  test('csv-quotes', "const s=api.register(api.createState(),{id:'a',name:'甲,\"乙\"',email:'a@example.test',consent:true},1);return api.toCSV(s).includes('\"甲,\"\"乙\"\"\"')")
  test('csv-formula-protected', "const s=api.register(api.createState(),{id:'a',name:'=SUM(1)',email:'a@example.test',consent:true},1);return api.toCSV(s).includes(\"'=SUM(1)\")")
}
for (const file of ['index.html','app.js','style.css','README.md']) {
  const text = await readFile(join(workspace, 'outputs', file), 'utf8').catch(() => '')
  add('file-' + file, text.length >= (file === 'style.css' ? 40 : 100), text.length)
  if (full && file === 'index.html') {
    add('html-has-form', /<form[\s>]/i.test(text)); add('html-has-labels', /<label[\s>]|aria-label=/i.test(text))
    add('no-external-scripts', !/<script[^>]+src=["']https?:/i.test(text))
  }
  if (full && file === 'app.js') {
    add('uses-domain', /domain\.js/.test(text)); add('has-persistence', /localStorage|indexedDB/.test(text))
    add('no-network-dependency', !/\bfetch\s*\(|https?:\/\//.test(text))
  }
}
console.log(JSON.stringify({ checks, hits: checks.filter(c=>c.passed).length, total: checks.length, passed: checks.every(c=>c.passed), full, note: 'Functional VM tests and static UI checks; browser interaction is verified separately.' }))
