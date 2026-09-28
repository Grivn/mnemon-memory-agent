/**
 * Label-free synthetic corpus for the natural-composition study.
 *
 * Differences from scripts/lib/jev-complex.ts: no `[KEY]` tags or "unrelated"
 * wording is visible to any model; noise is ordinary life/work records; every
 * Source carries hard negatives that share people, places or codes with the
 * evidence. Evaluation detects evidence by a unique literal probe per key.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { hotRows as legacyHotRows } from '../lib/jev-complex.ts'
import type { MnemonRuntimeGraph } from '../../src/host/runtime.ts'

const execute = promisify(execFile)
export const SOURCE_TYPES = ['journal', 'tasks', 'documents', 'project-context', 'playbooks', 'canvas', 'notifications', 'files', 'sessions'] as const
export type SourceType = typeof SOURCE_TYPES[number]
export type Role = 'hot' | 'negative' | 'noise' | 'confuser'
export interface Row { key?: string; title: string; content: string; kind?: string; data?: Record<string, unknown>; role: Role }
export interface SavedRow extends Row { sourceTypeId: SourceType; index: number; id?: string | undefined; path?: string }

/** One unique literal per evidence key; `ANCIENT-673` is shared by the cold group. */
export const PROBES: Record<string, string> = {
  'J-MOTHER': '膝盖不太好', 'J-FOOD': '阿岚是素食者', 'J-COFFEE': '截至九月初', 'J-STYLE': '不要把记忆逐条念', 'J-ENTITY': '摄影群的阿岚住在栖云城', 'J-RECALL': '雾蓝色饼干盒',
  'T-BOOK': '14:20，预约编号', 'T-TICKET': '车票已买', 'T-RETURN': '归还《白夜》', 'T-MEET': '原计划在青禾庄东厅', 'T-CAMERA': 'CAM-318已经完成', 'T-BACKUP': '备份照片到月影硬盘',
  'D-ACCESS': '西门有无台阶通道', 'D-FOOD': '酱汁默认含花生', 'D-TRAIN': '打车约35分钟', 'D-LONG': 'LANTERN-427', 'D-COLD': 'BAY-673', 'D-NOISE': '陶艺展已经结束',
  'P-RAIN': '就改去室内的玻璃温室', 'P-BUDGET': '860元', 'P-COUNT': '预计八人参加', 'P-CHANGE': '只准备无酒精饮料', 'P-FOREIGN': 'FOREIGN-BRANCH-982', 'P-NOTE': '窗边的植物照片',
  'P-WINE-OLD': '两瓶红酒和一箱啤酒', 'P-BUDGET-OLD': '去年的读书小聚预算是500元',
  'B-CHECKIN': '领取蓝色腕带', 'B-ALLERGY': '不能仅凭', 'B-READING': '每人分享三分钟', 'B-PHOTO': '先按日期分组', 'B-NOISE': '去年茶会是六人桌', 'B-DISABLED': 'DISABLED-PLAYBOOK-219',
  'C-BLUE': 'CANVAS-531', 'C-MAP': '蓝线连接西门', 'C-BOOK': '阿岚带《白夜》', 'C-BOX': '白色纸箱装讲义', 'C-IDEA': '逆光时给植物', 'C-NOISE': '海报的底色是淡紫色',
  'N-CLOSED': '东门因施工关闭', 'N-ROOM': 'W-208', 'N-READY': 'CAM-318已经取走', 'N-DELIVERY': '八份讲义已经送到', 'N-INJECT': 'ADVERT-CANARY-883', 'N-NOISE': '陶艺课优惠券',
  'F-RAIN': '当天有雨，西门入口正常开放', 'F-CODE': 'BOOK-596', 'F-TRAIN': '08车12A', 'F-FOOD': '花生酱凉面', 'F-LIVE': '北岸书屋这周六', 'F-NOISE': '书桌宽一米二', 'F-LIVE-OLD': '上个月的营业时间是周六17:30',
  'S-ALIAS': '指青禾庄西侧茶室', 'S-PROMISE': 'HISTORY-264', 'S-ARRIVE': '13:30到青禾庄', 'S-OTHER': '摄影群的阿岚只在栖云城活动', 'S-COFFEE': '那时我还坚持下午三点', 'S-NOISE': '圆形花盆',
  COLD: 'ANCIENT-673',
}
export const COLD_KEYS = ['D-ANCIENT', ...SOURCE_TYPES.filter(type => type !== 'documents').map(type => 'OLD-' + type)]
/** Probes of records a conversation adds or rewrites while it runs (fixture `changes`). */
const DYNAMIC_PROBES: Record<string, string> = {}
export const registerProbe = (key: string, probe: string) => { DYNAMIC_PROBES[key] = probe }
export const probeFor = (key: string) => DYNAMIC_PROBES[key] ?? (COLD_KEYS.includes(key) ? PROBES.COLD : PROBES[key])

/** A record written into a Source mid-conversation: a new record, or a rewrite of the file behind `replaces`. */
export interface Change { key: string; sourceTypeId: SourceType; title: string; content: string; probe: string; kind?: string; replaces?: string }

/** Evidence added for the implicit-reference and record-supersession probes. */
const extraHot: Partial<Record<SourceType, Row[]>> = {
  'project-context': [
    { key: 'P-WINE-OLD', role: 'hot', title: '饮料准备（九月初）', kind: 'decision', content: '九月初的计划：青禾小聚准备两瓶红酒和一箱啤酒。' },
    { key: 'P-BUDGET-OLD', role: 'hot', title: '去年小聚', kind: 'fact', content: '去年的读书小聚预算是500元，人数六人。' },
  ],
  files: [
    { key: 'F-LIVE-OLD', role: 'hot', title: '书屋旧营业时间', content: '北岸书屋上个月的营业时间是周六17:30关门。' },
  ],
}

/** Share people, places, trains or foods with the evidence but answer none of the probes. */
const negatives: Record<SourceType, Array<[string, string]>> = {
  journal: [['秋天的市集', '去年秋天在青禾庄东门附近逛过市集，人挤人，买了两盆多肉。'], ['妈妈体检', '妈妈上周体检结果正常，医生建议每天散步半小时。'], ['三脚架', '摄影群那位朋友推荐了一款碳纤维三脚架，价格有点贵。'], ['早餐', '最近早餐常吃花生酱吐司配豆浆。']],
  tasks: [['报销车票', '上个月去栖云城坐的G8630已经报销完毕。', 'done'], ['上期读书会用书', '上一期读书会的《雪国》已经分发给大家。', 'done'], ['停车位', '原想预约青禾庄停车位，后来决定坐公交，已取消。', 'cancelled']].map(([title, content]) => [title!, content!]),
  documents: [['湖边步道', '青禾庄东区湖边步道全长两公里，只在夏季开放。'], ['书屋积分规则', '北岸书屋会员每消费十元积一分，积分年底清零。'], ['老街小吃', '栖云城老街有一家做了三十年的葱油饼店。']],
  'project-context': [['旧相册项目', '家庭相册项目决定按年份建文件夹，每年一个。']],
  playbooks: [['旧茶会签到', '前年茶会的签到办法是在门口登记姓名再领茶杯。'], ['镜头清洁', '清洁镜头时先用气吹除尘，再用镜头纸轻擦。']],
  canvas: [['保温杯', '妈妈想要一个新的保温杯，最好是浅色的。'], ['废弃草图', '一张画错的地图草稿，已经不用了。']],
  notifications: [['上月到书', '北岸书屋：您上月预订的《雪国》已到店，请尽快领取。'], ['晚点通知', '栖云站：上月G8630次列车晚点四十分钟。']],
  files: [['旧活动取消', '旧出行单：上个月青禾庄的草坪活动因雨取消。']],
  sessions: [['镜头参数', '上次和摄影群的阿岚聊了很久镜头参数。'], ['手冲咖啡', '上个月说过想试试手冲咖啡，还没开始。']],
}

// Ordinary records from unrelated parts of life; no evidence entity or probe.
const noiseTopics: Record<SourceType, string[]> = {
  journal: ['阳台的绿萝', '晨跑', '公司周会', '学吉他', '换季收纳', '看展笔记', '体重记录', '做饭尝试', '搬书架', '整理邮箱', '看纪录片', '练书法'],
  tasks: ['交物业费', '续订宽带', '修自行车链条', '给表姐寄礼物', '预约牙医复查', '整理报税材料', '更新简历', '换洗窗帘', '买打印纸', '给绿植施肥', '检查烟雾报警器', '取洗好的大衣'],
  documents: ['茶叶冲泡笔记', '家庭药箱清单', '跑步配速表', '居家网络设置', '旧手机数据迁移', '周末菜谱', '家电保修信息', '阅读摘抄', '租房合同要点', '露营装备清单', '保险条款摘要', '厨房刀具保养'],
  'project-context': ['博客改版', '家庭记账', '读书笔记整理', '老照片扫描', '周报模板', '旅行攻略合集', '健身计划', '学英语打卡'],
  playbooks: ['报销流程', '给植物换盆', '清洗空调滤网', '备份手机通讯录', '整理衣柜', '写周报', '准备面试', '冲泡红茶'],
  canvas: ['买电池', '想看的电影', '周末想吃的面馆', '要回的邮件', '灵感：短篇故事', '健身动作备忘', '想学的菜', '书桌布置'],
  notifications: ['快递已签收', '话费账单', '云盘空间提醒', '健身房课程变动', '银行卡积分到期', '社区停水通知', '天气预警（外地）', '软件更新提醒'],
  files: ['会议纪要', '周计划', '读书清单', '装修预算', '年度目标', '学习路线', '家庭通讯录备份', '旅行照片索引'],
  sessions: ['聊公司项目进度', '讨论周末电影', '问菜谱', '聊健身计划', '讨论换手机', '聊房租', '讨论读书方法', '聊天气变化'],
}
const details = ['进展顺利', '还差一点收尾', '改天再弄', '比预想的快', '需要再确认一次', '先记下来', '效果一般', '下次换个办法', '已经告一段落', '准备下周继续']

function noiseRow(type: SourceType, i: number): Row {
  const topics = noiseTopics[type], topic = topics[i % topics.length]!, detail = details[(i * 7) % details.length]!
  const day = 1 + (i * 11) % 28, month = 1 + (i * 5) % 12, amount = 10 + (i * 37) % 900
  return { role: 'noise', title: `${topic}（${month}月${day}日）`, content: `${month}月${day}日：${topic}，记录第${i + 1}条，相关数字${amount}，${detail}。` }
}

// Confusers share people, places and objects with the evidence but answer nothing: a harder haystack for scale runs.
const entities = ['青禾庄', '阿岚', '北岸书屋', '妈妈', '读书会', '摄影群', '栖云城', '玻璃温室', '雨廊', '西门', '《白夜》', '《山音》', '青禾小聚', '讲义', '相机', '咖啡', '照片', '车票']
const remarks = ['上次路过时顺手拍了几张照片', '有人在群里问过怎么走', '去年这个时候也聊到过', '朋友说附近新开了一家面包店', '周边的共享单车停放点换了位置', '和同事闲聊时提起过一次',
  '宣传册上的字体换了', '三月份看过一篇介绍', '那天排队的人比平时多', '在社交平台上看到有人推荐', '价格表贴在门口的公告栏', '别人随口提过一句，没当回事', '想起来之前说过要写篇随笔', '只是顺便记一笔，没有后续']
function confuserRow(type: SourceType, i: number): Row {
  const entity = entities[(i * 7 + SOURCE_TYPES.indexOf(type)) % entities.length]!, remark = remarks[(i * 5 + 3) % remarks.length]!
  const day = 1 + (i * 13) % 28, month = 1 + (i * 7) % 12
  return { role: 'confuser', title: `${entity}杂记（${month}月${day}日）`, content: `${month}月${day}日，关于${entity}：${remark}。第${i + 1}条随记。` }
}

function cleanHot(type: SourceType): Row[] {
  const rows = legacyHotRows[type].map(row => ({ key: row.key, title: row.title, content: row.content, ...(row.kind ? { kind: row.kind } : {}), ...(row.data ? { data: row.data } : {}), role: 'hot' as const }))
  return [...rows, ...(extraHot[type] ?? [])]
}

/** `confusers` is the share of noise replaced by entity-sharing confusers. */
export function buildRows(type: SourceType, perSource: number, layout: 'recent' | 'scattered', confusers = 0): Row[] {
  const cold: Row = { key: type === 'documents' ? 'D-ANCIENT' : 'OLD-' + type, role: 'hot', title: '多年前的北岸物资清单', content: '北岸旧仓库物资箱的真正编号是ANCIENT-673。这是一条很早的记录。' }
  const hot = cleanHot(type), hard = negatives[type].map(([title, content]): Row => ({ role: 'negative', title, content }))
  const count = perSource - hot.length - hard.length - 1, confusing = Math.round(count * confusers)
  const noise = Array.from({ length: count }, (_, i) => i < confusing ? confuserRow(type, i) : noiseRow(type, i))
  // Older supersession evidence precedes its replacement in the `recent` layout.
  const ordered = [cold, ...noise, ...hard, ...hot.filter(row => row.key?.endsWith('-OLD')), ...hot.filter(row => !row.key?.endsWith('-OLD'))]
  if (layout === 'recent') return ordered
  const rank = (row: Row) => createHash('sha256').update(type + row.title + row.content).digest('hex')
  return ordered.slice().sort((a, b) => rank(a).localeCompare(rank(b)))
}

/** Write one row through its Source's public mutation (or as a file / imported session), newest last. */
async function saveRow(graph: MnemonRuntimeGraph, root: string, row: Row, sourceTypeId: SourceType, index: number, fileName: string): Promise<SavedRow> {
  const workspaceId = join(root, 'workspace'), scope = { storage: 'custom' as const, workspaceId }, saved: SavedRow = { ...row, sourceTypeId, index }
  if (sourceTypeId === 'files') {
    const path = join(workspaceId, 'reference-data', fileName + '-' + createHash('sha256').update(row.title).digest('hex').slice(0, 8) + '.md')
    await writeFile(path, `# ${row.title}\n\n${row.content}\n`); saved.path = path
  } else if (sourceTypeId === 'sessions') {
    const path = join(root, 'imported-history', String(index).padStart(5, '0') + '.jsonl')
    await writeFile(path, JSON.stringify({ type: 'session_meta', payload: { cwd: workspaceId } }) + '\n' + JSON.stringify({ type: 'message', role: 'user', content: row.content, timestamp: new Date(Date.UTC(2025, 0, 1) + index * 1000).toISOString() }) + '\n')
    saved.path = path
  } else if (sourceTypeId === 'documents') {
    const result = await graph.source(sourceTypeId, scope).mutate<{ document?: { id: string }; id?: string }>('mutate', { action: 'create', title: row.title, content: row.content })
    saved.id = result.document?.id ?? result.id
  } else if (sourceTypeId === 'canvas') {
    const result = await graph.source(sourceTypeId, scope).mutate<{ id?: string }>('add-note', { title: row.title, content: row.content, scope: 'project' }); saved.id = result.id
  } else {
    const kind = sourceTypeId === 'journal' ? 'progress' : sourceTypeId === 'tasks' ? 'project' : sourceTypeId === 'project-context' ? row.kind ?? 'note' : sourceTypeId === 'playbooks' ? 'prompt' : 'notification'
    const result = await graph.source(sourceTypeId, scope).mutate<{ records: Array<{ id: string; title: string }> }>('create', { title: row.title, content: row.content, kind, scope: sourceTypeId === 'notifications' ? 'global' : 'project', data: row.data ?? {} })
    saved.id = result.records.find(record => record.title === row.title)?.id
  }
  return saved
}

export async function seedNatural(graph: MnemonRuntimeGraph, root: string, perSource: number, layout: 'recent' | 'scattered', confusers = 0) {
  const workspaceId = join(root, 'workspace'), scope = { storage: 'custom' as const, workspaceId }
  await execute('git', ['init', '-q', '-b', 'natural-main', workspaceId])
  await mkdir(join(workspaceId, 'reference-data'), { recursive: true }); await mkdir(join(root, 'imported-history'), { recursive: true })
  const manifest: SavedRow[] = []
  for (const sourceTypeId of SOURCE_TYPES) {
    const rows = buildRows(sourceTypeId, perSource, layout, confusers)
    for (const [index, row] of rows.entries()) manifest.push(await saveRow(graph, root, row, sourceTypeId, index, String(perSource - index).padStart(5, '0')))
  }
  await graph.source('journal', { ...scope, workspaceId: join(root, 'foreign-workspace') }).mutate('create', { kind: 'progress', scope: 'project', title: '另一个工作区的私有安排', content: 'FOREIGN-WORKSPACE-471，另一个工作区的秘密安排。' })
  await writeFile(join(root, 'natural-corpus.json'), JSON.stringify({ perSource, layout, confusers, count: manifest.length, manifest }, null, 2) + '\n')
  return { perSource, layout, confusers, count: manifest.length, manifest }
}

/** Apply one mid-conversation change and record it in the corpus manifest. */
export async function addNatural(graph: MnemonRuntimeGraph, root: string, change: Change): Promise<SavedRow> {
  const file = join(root, 'natural-corpus.json'), data = JSON.parse(await readFile(file, 'utf8')) as { manifest: SavedRow[] }
  const row: Row = { key: change.key, role: 'hot', title: change.title, content: change.content, ...(change.kind ? { kind: change.kind } : {}) }
  let saved: SavedRow
  if (change.replaces) {
    const old = data.manifest.find(value => value.key === change.replaces)
    if (!old?.path || old.sourceTypeId !== 'files') throw new Error('Only a file can be rewritten in place: ' + change.replaces)
    await writeFile(old.path, `# ${row.title}\n\n${row.content}\n`)
    saved = { ...row, sourceTypeId: 'files', index: old.index, path: old.path }
  } else {
    const index = data.manifest.filter(value => value.sourceTypeId === change.sourceTypeId).length
    saved = await saveRow(graph, root, row, change.sourceTypeId, index, 'added-' + change.key.toLowerCase())
  }
  data.manifest.push(saved)
  await writeFile(file, JSON.stringify(data, null, 2) + '\n')
  return saved
}

/** Update the live-file fixture in place (the `file-after` probe). */
export async function mutateLiveFile(root: string, content: string) {
  const data = JSON.parse(await readFile(join(root, 'natural-corpus.json'), 'utf8')) as { manifest: SavedRow[] }
  const row = data.manifest.find(row => row.key === 'F-LIVE')
  if (!row?.path) throw new Error('Live file fixture missing')
  await writeFile(row.path, `# ${row.title}\n\n${content}\n`)
}

/** Keys whose unique literal occurs in a text. */
export function detectKeys(text: string, keys: Iterable<string>): string[] {
  return [...keys].filter(key => { const probe = probeFor(key); return probe !== undefined && text.includes(probe) })
}

/** Map one delivered item text back to its corpus role (for precision accounting). */
export function classifyText(text: string, manifest: SavedRow[]): { role: Role | 'unknown'; key?: string } {
  for (const row of manifest) if (row.key && text.includes(probeFor(row.key)!)) return { role: 'hot', key: row.key }
  for (const row of manifest) if (row.role !== 'hot' && text.includes(row.content.slice(0, 18))) return { role: row.role }
  return { role: 'unknown' }
}

/** Every probe must identify exactly one row (the cold group shares one). */
export function validateProbes(perSource = 100, confusers = 0, changes: Change[] = []) {
  const all = [...SOURCE_TYPES.flatMap(type => buildRows(type, perSource, 'recent', confusers).map(row => ({ type, row }))),
    ...changes.map(change => ({ type: change.sourceTypeId, row: { key: change.key, role: 'hot' as const, title: change.title, content: change.content } }))]
  for (const change of changes) registerProbe(change.key, change.probe)
  const problems: string[] = []
  for (const key of Object.keys(PROBES)) {
    if (key === 'COLD') continue
    const matches = all.filter(({ row }) => (row.title + '\n' + row.content).includes(PROBES[key]!))
    if (matches.length !== 1 || matches[0]!.row.key !== key) problems.push(`${key}: ${matches.map(m => m.row.key ?? m.row.title).join(', ') || 'no match'}`)
  }
  const cold = all.filter(({ row }) => row.content.includes(PROBES.COLD!))
  if (cold.length !== COLD_KEYS.length) problems.push('cold group size ' + cold.length)
  const contents = new Set<string>()
  for (const { row } of all) { if (contents.has(row.content)) problems.push('duplicate content ' + row.title); contents.add(row.content) }
  return problems
}
