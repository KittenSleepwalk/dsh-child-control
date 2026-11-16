/**
 * dsh-child-control - 宿主端集成测试。
 *
 * 用真实 webServer 服务（@deepseek-ai/dsh-host-webserver）+ 真实 cordis Context
 * 挂载本插件，再用真 HTTP 请求打 /dsh-child-control/*，断言：
 *   - 路由注册与 JSON 契约可用；
 *   - 子进程树按深度/父子关系构建成 pre-order（durable listing ∪ 进程内 Agent 注册表）；
 *   - 一键停止按「深 -> 浅」分组调用 drainContinuableChildren（真正释放路径）；
 *   - 后台作业先于 Agent 释放被终止（kill 需要活 owner 作为授权者）；
 *   - 删除会话的根会话/越权/仍驻留保护，以及日志目录移入回收目录；
 *   - 主会话被用户停止（turn/end aborted reason=user）时自动级联停止后代。
 */
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const APP_NM = process.env.DSH_APP_NODE_MODULES
  || join(process.env.APPDATA || homedir(), 'io.github.hairyf.deepseek-harness-desktop', 'dependencies', 'dsh', 'node_modules')
const PLUGIN = new URL('../lib/index.js', import.meta.url)

const failures = []
function check(label, condition, detail) {
  if (condition) console.log('  ok   ' + label)
  else {
    failures.push(label)
    console.log('  FAIL ' + label + (detail === undefined ? '' : ' :: ' + detail))
  }
}
function equal(label, actual, expected) {
  check(label, JSON.stringify(actual) === JSON.stringify(expected),
    'got ' + JSON.stringify(actual) + ' want ' + JSON.stringify(expected))
}

const home = await mkdtemp(join(tmpdir(), 'dsh-child-control-'))
process.env.DSH_HOME = home
await mkdir(join(home, 'sessions', '--proj--', 'child-a'), { recursive: true })
await writeFile(join(home, 'sessions', '--proj--', 'child-a', 'session.v1.jsonl.zstd'), 'log', 'utf8')

const load = spec => import(pathToFileURL(join(APP_NM, spec)).href)
const { Context } = await load('@deepseek-ai/cordis/lib/index.js')
const webServerModule = await load('@deepseek-ai/dsh-host-webserver/lib/index.js')
const WebServer = webServerModule.default ?? webServerModule.WebServer
const plugin = await import(PLUGIN.href)

const calls = []

function makeAgent(id, parentSession, status) {
  const agent = {
    id,
    status,
    session: { header: { id, parentSession, createdAt: 1000 + id.length } },
    cancel(cause, options) { calls.push(['cancel', id, cause, options]); agent.status = 'idle' },
  }
  return agent
}

const agents = new Map()

/** 每个小节前把内存态恢复到确定状态。 */
function reseed() {
  agents.clear()
  agents.set('root', makeAgent('root', undefined, 'running'))
  agents.set('child-a', makeAgent('child-a', 'root', 'running'))
  agents.set('child-b', makeAgent('child-b', 'child-a', 'running'))
  agents.set('child-stuck', makeAgent('child-stuck', 'root', 'running'))
}

const durable = [
  { kind: 'child', id: 'child-a', parentId: 'root', depth: 1, activity: 'running', hasChildren: true, mode: 'continuable', label: '研究员 A' },
  { kind: 'child', id: 'child-b', parentId: 'child-a', depth: 2, activity: 'inactive', hasChildren: false, mode: 'continuable', label: '研究员 B' },
  { kind: 'child', id: 'child-cold', parentId: 'root', depth: 1, activity: 'inactive', hasChildren: false, mode: 'continuable', label: '冷会话 C' },
  { kind: 'child', id: 'child-stuck', parentId: 'root', depth: 1, activity: 'running', hasChildren: false, mode: 'continuable', label: '顽固子智能体' },
]

/** 这批 id 的 drain 不生效，用来验证「停止失败就不许删会话」。 */
const STUCK = new Set(['child-stuck'])

const subagentsStub = {
  async listDescendants() { return durable },
  async drainContinuableChildren(parent, ids) {
    calls.push(['drain', String(parent.id), [...ids]])
    for (const id of ids) if (!STUCK.has(id)) agents.delete(id)
  },
  interrupt(id, authority) { calls.push(['interrupt', id, authority]) },
  async prompt(request) { calls.push(['prompt', request.childSessionId, request.delivery]); return { messageId: 'msg-1' } },
  async startContinuable(spec) {
    calls.push(['start', spec.provider, spec.label, spec.request.prompt[0].text])
    return { childId: 'child-new', messageId: 'msg-2' }
  },
}

const jobsStub = {
  list(caller) {
    const owner = caller === undefined ? undefined : String(caller.id)
    return [
      { id: 'bash-1', kind: 'bash', label: 'npm run dev', status: 'running', ownerSession: 'root', startedAt: 1 },
      { id: 'bash-2', kind: 'bash', label: 'pnpm test', status: 'running', ownerSession: 'child-a', startedAt: 2 },
    ].filter(job => (owner === undefined ? job.ownerSession === undefined : job.ownerSession === owner))
  },
  kill(id) { calls.push(['kill', String(id)]); return 'requested' },
}

const ctx = new Context()
await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0, compression: 'none' })
const provide = (name, value) => (typeof ctx.provide === 'function' ? ctx.provide(name, value) : ctx.reflect.provide(name, value))
provide('agents', { get: id => agents.get(String(id)), list: () => [...agents.values()] })
provide('subagents', subagentsStub)
provide('jobs', jobsStub)
await ctx.plugin(plugin)

const base = 'http://127.0.0.1:' + ctx.get('webServer').port + '/dsh-child-control'
const get = async path => {
  const response = await fetch(base + path)
  return { status: response.status, body: await response.json() }
}
const post = async (path, body) => {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  return { status: response.status, body: await response.json() }
}
const drainCalls = () => calls.filter(call => call[0] === 'drain').map(call => [call[1], call[2]])

reseed()

try {
  console.log('\n[1] GET /tree')
  const tree = await get('/tree?sessionId=root')
  check('HTTP 200', tree.status === 200, String(tree.status))
  equal('根状态', [tree.body.root.id, tree.body.root.live, tree.body.root.running], ['root', true, true])
  equal('pre-order（父先于子）', tree.body.rows.map(row => row.id), ['child-a', 'child-b', 'child-cold', 'child-stuck'])
  equal('深度', tree.body.rows.map(row => row.depth), [1, 2, 1, 1])
  equal('父子关系', tree.body.rows.map(row => row.parentId), ['root', 'child-a', 'root', 'root'])
  equal('驻留状态（冷会话不在注册表）', tree.body.rows.map(row => row.live), [true, true, false, true])
  equal('标签来自投影', tree.body.rows[0].label, '研究员 A')
  equal('作业行（root + child-a 各一）', tree.body.jobs.map(job => job.id).sort(), ['bash-1', 'bash-2'])
  equal('缺少 sessionId 报 400', (await get('/tree')).status, 400)

  console.log('\n[2] POST /stop-all：深->浅真正释放 + 终止作业')
  reseed()
  calls.length = 0
  const stopped = await post('/stop-all', { sessionId: 'root' })
  check('HTTP 200', stopped.status === 200, String(stopped.status))
  equal('先释放 L2 再释放 L1（冷会话同交父亲）', drainCalls(), [
    ['child-a', ['child-b']],
    ['root', ['child-a', 'child-cold', 'child-stuck']],
  ])
  equal('作业被终止（含子智能体自己的作业）', calls.filter(call => call[0] === 'kill').map(call => call[1]).sort(), ['bash-1', 'bash-2'])
  check('kill 先于 drain（先保住授权者）',
    calls.findIndex(call => call[0] === 'kill') < calls.findIndex(call => call[0] === 'drain'),
    JSON.stringify(calls.map(call => call[0])))
  equal('顽固目标如实回报仍驻留', stopped.body.stillLive, ['child-stuck'])

  console.log('\n[3] POST /stop：单行 + 其整棵子树')
  reseed()
  calls.length = 0
  const one = await post('/stop', { sessionId: 'root', childId: 'child-a' })
  check('HTTP 200', one.status === 200, String(one.status))
  equal('先释放 child-a 的孩子，再释放 child-a 自己', drainCalls(), [
    ['child-a', ['child-b']],
    ['root', ['child-a']],
  ])
  check('未触及兄弟分支', !calls.some(call => call[0] === 'drain' && call[2].includes('child-stuck')), JSON.stringify(calls))

  console.log('\n[4] POST /add + /prompt')
  reseed()
  calls.length = 0
  const added = await post('/add', { sessionId: 'root', label: '知识库', prompt: '记住 A=1' })
  check('HTTP 200', added.status === 200, JSON.stringify(added.body))
  equal('创建走 startContinuable（spawn）', calls[0], ['start', 'spawn', '知识库', '记住 A=1'])
  equal('返回新子 id', added.body.childId, 'child-new')
  const prompted = await post('/prompt', { sessionId: 'root', childId: 'child-a', text: '继续' })
  check('HTTP 200', prompted.status === 200, JSON.stringify(prompted.body))
  equal('投递为 queue 轮次', calls.find(call => call[0] === 'prompt'), ['prompt', 'child-a', 'queue'])
  equal('空提示词报 400', (await post('/prompt', { sessionId: 'root', childId: 'child-a', text: '  ' })).status, 400)

  console.log('\n[5] POST /session/delete：保护 + 回收')
  reseed()
  equal('拒绝删除根会话', (await post('/session/delete', { sessionId: 'root', childId: 'root' })).status, 400)
  equal('拒绝非后代', (await post('/session/delete', { sessionId: 'root', childId: 'outside' })).status, 403)
  equal('停止没生效就拒绝删除', (await post('/session/delete', { sessionId: 'root', childId: 'child-stuck' })).status, 409)
  check('被拒后日志仍在', existsSync(join(home, 'sessions', '--proj--', 'child-a')))
  calls.length = 0
  const deleted = await post('/session/delete', { sessionId: 'root', childId: 'child-a' })
  check('停止成功后删除', deleted.status === 200, JSON.stringify(deleted.body))
  check('删除前确实走了真正停止路径', calls.some(call => call[0] === 'drain' && call[2].includes('child-a')), JSON.stringify(calls))
  check('日志目录已移走', !existsSync(join(home, 'sessions', '--proj--', 'child-a')))
  const trash = await readdir(join(home, 'child-control-trash'))
  check('回收目录留有备份', trash.some(name => name.endsWith('child-a')), JSON.stringify(trash))

  console.log('\n[6] 级联：主会话被用户停止 -> 自动停止全部后代')
  reseed()
  calls.length = 0
  ctx.emit('session/event', { id: 'root', header: {} },
    { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  await new Promise(resolve => setTimeout(resolve, 300))
  check('级联触发了 drain', calls.some(call => call[0] === 'drain'), JSON.stringify(calls))
  calls.length = 0
  ctx.emit('session/event', { id: 'child-a', header: { parentSession: 'root' } },
    { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  await new Promise(resolve => setTimeout(resolve, 200))
  check('子会话被停止不触发级联', !calls.some(call => call[0] === 'drain'), JSON.stringify(calls))
  calls.length = 0
  ctx.emit('session/event', { id: 'root', header: {} }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await new Promise(resolve => setTimeout(resolve, 200))
  check('正常结束这一轮不触发级联', !calls.some(call => call[0] === 'drain'), JSON.stringify(calls))
} finally {
  await ctx.fiber.dispose()
}

console.log('\n' + (failures.length === 0 ? 'ALL PASS' : 'FAILED: ' + failures.join(' | ')))
process.exit(failures.length === 0 ? 0 : 1)
