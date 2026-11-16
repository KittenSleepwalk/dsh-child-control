/**
 * dsh-child-control — 宿主端。
 *
 * 解决两件事：
 *   1. 「一键停止全部子智能体」。DSH 的两个既有停止入口都只停一层：
 *      - 对话框的 Stop 走 `session.cancel` → `agent.cancel({kind:'user'}, {keepInbox:true})`，
 *        只中止主会话当前这一轮，完全不动 `ctx.subagents` 里的子 Activation；
 *      - 模型的 `interrupt_agent` 走 `ctx.subagents.interrupt()` → 同样只 `cancel` 目标
 *        当前轮（`keepInbox:true`），既不停它的后代，也不释放它的 Activation。
 *      真正「停掉」一个 continuable 子智能体只能靠连续性管理器的释放路径：
 *      `ctx.subagents.drainContinuableChildren(parentAgent, childIds)`，
 *      它按孩子优先顺序 dispose 每个 Activation 及其 `AgentHandle`。
 *      本插件把它按「深度从深到浅」补全成整棵树，并对拿不到活父亲的分支降级为
 *      `interrupt`（停当前轮）+ `agent.cancel`。
 *   2. 把「当前会话的完整子进程表单」列出来：会话后端的子智能体（durable listing
 *      + 进程内 Agent 注册表并集）与 `ctx.jobs` 后台作业，并支持新增 / 发送提示词 /
 *      停止 / 删除会话（会话日志移入回收目录）。
 *
 * 路由挂在 `ctx.webServer` 上（`/dsh-child-control/*`），浏览器端 `lib/client.js`
 * 只做 UI 与 fetch。宿主端不 import 任何 @deepseek-ai 包，全部走 ctx.get()，
 * 这样即使某个服务缺席也只让单个路由报错，不会带崩整棵树。
 *
 * @module dsh-child-control
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-child-control'
export const inject = ['webServer']

const PREFIX = '/dsh-child-control'
const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const SESSIONS_DIR = join(HOME, 'sessions')
const TRASH_DIR = join(HOME, 'child-control-trash')
const BUILD = '0.1.0'
const DEFAULT_PROVIDER = process.env.DSH_CHILD_CONTROL_PROVIDER || 'spawn'
const CASCADE = process.env.DSH_CHILD_CONTROL_CASCADE !== '0'
const BOOTSTRAP_PROMPT =
  '你已被登记为一个待命子智能体。现在只回复一句话「已就绪」表示收到，不要调用任何工具，不要开始任何工作。'
const CONTROL_TIMEOUT_MS = 120_000

/** 请求是否来自本机回环（IPv4、IPv6 及其 v4-mapped 形式）。 */
function isLoopback(req) {
  const address = req?.socket?.remoteAddress
  if (typeof address !== 'string' || address === '') return false
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function json(res, value, status = 200) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

async function readBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > 1 << 20) return null
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

function messageOf(error) {
  if (error === null || error === undefined) return 'unknown error'
  const code = typeof error.code === 'string' ? error.code : undefined
  const message = error instanceof Error ? error.message : String(error)
  return code === undefined ? message : `${code}: ${message}`
}

function text(value, limit) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed
}

function idOf(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : ''
}

/** 惰性取服务：缺席只影响用到它的那一个分支。 */
function services(ctx) {
  return {
    ctx,
    agents: ctx.get('agents'),
    subagents: ctx.get('subagents'),
    jobs: ctx.get('jobs'),
  }
}

/**
 * 采集当前会话的完整子进程树 + 后台作业。
 *
 * 行集合 = 会话后端子智能体（`listDescendants`，含冷会话）∪ 进程内 Agent 注册表
 * 里 `parentSession` 链能回溯到根的活动 Agent。两边的 `parentId` 合成一张父指针
 * 表，再从根做一次 DFS 得到稳定 pre-order，因此「后端有记录但当前不在内存」与
 * 「内存里活着但后端还没分类」两种行都不会漏。
 *
 * @param ctx - 宿主上下文。
 * @param rootId - 根会话 id（用户当前所在会话）。
 * @returns 表格数据（rows / jobs / errors）与根状态。
 */
async function readTree(ctx, rootId) {
  const { agents, subagents, jobs } = services(ctx)
  const errors = []
  const rootAgent = agents?.get?.(rootId)
  const live = new Map()
  if (agents?.list) {
    for (const agent of agents.list()) live.set(String(agent.id), agent)
  }

  let durable = []
  if (subagents?.listDescendants) {
    try {
      durable = await subagents.listDescendants(rootId, AbortSignal.timeout(20_000))
    } catch (error) {
      errors.push(`listDescendants: ${messageOf(error)}`)
    }
  }

  const parentOf = new Map()
  const labelOf = new Map()
  const modeOf = new Map()
  for (const entry of durable) {
    const id = idOf(entry?.id)
    if (id === '') continue
    if (typeof entry.parentId === 'string') parentOf.set(id, String(entry.parentId))
    if (entry.kind === 'child') {
      if (typeof entry.label === 'string') labelOf.set(id, entry.label)
      if (entry.mode === 'one-shot' || entry.mode === 'continuable') modeOf.set(id, entry.mode)
    }
  }

  const childrenOf = new Map()
  const addEdge = (parent, child) => {
    if (parent === child) return
    if (!childrenOf.has(parent)) childrenOf.set(parent, [])
    const list = childrenOf.get(parent)
    if (!list.includes(child)) list.push(child)
  }
  for (const [child, parent] of parentOf) addEdge(parent, child)
  for (const [id, agent] of live) {
    const parent = agent?.session?.header?.parentSession
    if (typeof parent === 'string' && parent !== rootId) addEdge(String(parent), id)
  }

  const rows = []
  const visited = new Set([rootId])
  const ordered = []
  const stack = [...(childrenOf.get(rootId) ?? [])].reverse()
    .map(id => ({ id, depth: 1, parentId: rootId }))
  while (stack.length > 0) {
    const node = stack.pop()
    if (visited.has(node.id)) continue
    visited.add(node.id)
    ordered.push(node)
    const children = childrenOf.get(node.id) ?? []
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index]
      if (!visited.has(child)) stack.push({ id: child, depth: node.depth + 1, parentId: node.id })
    }
  }
  for (const node of ordered) {
    const agent = live.get(node.id)
    const header = agent?.session?.header
    rows.push({
      id: node.id,
      parentId: node.parentId,
      depth: node.depth,
      label: labelOf.get(node.id) ?? '',
      mode: modeOf.get(node.id) ?? (agent === undefined ? 'unknown' : 'live'),
      live: agent !== undefined,
      status: agent === undefined ? 'inactive' : (agent.status ?? 'idle'),
      durable: parentOf.has(node.id),
      createdAt: typeof header?.createdAt === 'number' ? header.createdAt : undefined,
    })
  }

  const jobRows = []
  const seenJobs = new Set()
  const callers = [rootAgent, ...rows.map(row => live.get(row.id)).filter(agent => agent !== undefined), undefined]
  if (jobs?.list) {
    for (const caller of callers) {
      let list = []
      try {
        list = jobs.list(caller)
      } catch (error) {
        errors.push(`jobs.list: ${messageOf(error)}`)
        continue
      }
      for (const job of list ?? []) {
        const id = String(job.id)
        if (seenJobs.has(id)) continue
        seenJobs.add(id)
        jobRows.push({
          id,
          kind: String(job.kind ?? ''),
          label: String(job.label ?? ''),
          status: String(job.status ?? ''),
          ownerSession: job.ownerSession === undefined ? undefined : String(job.ownerSession),
          startedAt: job.startedAt,
          finishedAt: job.finishedAt,
          detail: job.detail === undefined ? undefined : String(job.detail),
        })
      }
    }
  }

  return {
    root: {
      id: rootId,
      live: rootAgent !== undefined,
      running: rootAgent !== undefined && rootAgent.status === 'running',
    },
    rows,
    jobs: jobRows,
    errors,
  }
}

/**
 * 真正停止一批子智能体。
 *
 * 主路径是 `drainContinuableChildren(parentAgent, ids)`：连续性管理器会先同步
 * 下发 cancel，再按孩子优先顺序 dispose 整棵子树（含 `AgentHandle` 与其后代）。
 * 因此最深处那一批一次调用就能带走整片森林；这里仍按深度从深到浅分组，是为了
 * 覆盖「父 Activation 不驻留、只有孙节点驻留」这类不完整所有权图。
 * 拿不到活父亲时降级为 `interrupt(childId, {kind:'user', parentSessionId})`
 * （不需要活父亲，只停当前轮），最后对任何仍活着的目标再补一次 `agent.cancel`。
 *
 * @param ctx - 宿主上下文。
 * @param rootId - 根会话 id。
 * @param targets - 目标 id 集合（不含根）。
 * @returns 每个目标的处置结果。
 */
async function stopNodes(ctx, rootId, targets) {
  const { agents, subagents } = services(ctx)
  const tree = await readTree(ctx, rootId)
  const selected = tree.rows.filter(row => targets.has(row.id))
  const results = []
  const byParent = new Map()
  for (const row of selected) {
    if (!byParent.has(row.parentId)) byParent.set(row.parentId, [])
    byParent.get(row.parentId).push(row)
  }
  const depths = [...new Set(selected.map(row => row.depth))].sort((left, right) => right - left)

  for (const depth of depths) {
    for (const [parentId, group] of byParent) {
      const ids = group.filter(row => row.depth === depth).map(row => row.id)
      if (ids.length === 0) continue
      const parentAgent = agents?.get?.(parentId)
      const canDrain = parentAgent !== undefined && typeof subagents?.drainChildren === 'function'
      if (canDrain) {
        try {
          await subagents.drainChildren(parentAgent, ids)
          for (const id of ids) results.push({ id, via: 'drain', parent: parentId })
          continue
        } catch (error) {
          results.push({ id: ids.join(','), via: 'drain-failed', parent: parentId, error: messageOf(error) })
        }
      }
      for (const id of ids) {
        let stopped = false
        if (typeof subagents?.interrupt === 'function') {
          try {
            subagents.interrupt(id, { kind: 'user', parentSessionId: parentId })
            stopped = true
            results.push({ id, via: 'interrupt', parent: parentId })
          } catch (error) {
            results.push({ id, via: 'interrupt-failed', parent: parentId, error: messageOf(error) })
          }
        }
        if (!stopped) results.push({ id, via: 'no-path', parent: parentId })
      }
    }
  }

  for (const row of selected) {
    const agent = agents?.get?.(row.id)
    if (agent === undefined) continue
    try {
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      results.push({ id: row.id, via: 'cancel', parent: row.parentId })
    } catch (error) {
      results.push({ id: row.id, via: 'cancel-failed', parent: row.parentId, error: messageOf(error) })
    }
  }

  const after = await readTree(ctx, rootId)
  const stillLive = after.rows.filter(row => targets.has(row.id) && row.live).map(row => row.id)
  return { results, stillLive, before: selected.length }
}

/** 终止属于树内成员的后台作业；根自己的作业只在 includeRoot 时处理。 */
async function stopJobs(ctx, rootId, includeRoot) {
  const { agents, jobs } = services(ctx)
  const tree = await readTree(ctx, rootId)
  const owners = new Map()
  if (includeRoot) owners.set(rootId, agents?.get?.(rootId))
  for (const row of tree.rows) owners.set(row.id, agents?.get?.(row.id))
  const results = []
  if (!jobs?.kill) return results
  for (const [ownerId, agent] of owners) {
    if (agent === undefined) continue
    let list = []
    try {
      list = jobs.list(agent)
    } catch {
      continue
    }
    for (const job of list ?? []) {
      if (String(job.ownerSession ?? '') !== ownerId) continue
      try {
        results.push({ id: String(job.id), via: 'kill', outcome: jobs.kill(job.id, agent, 'stopped by dsh-child-control') })
      } catch (error) {
        results.push({ id: String(job.id), via: 'kill-failed', error: messageOf(error) })
      }
    }
  }
  return results
}

/** 在 sessions 根下按会话 id 定位目录（布局：<sessions>/<projectKey>/<id>/）。 */
async function findSessionDir(childId) {
  const direct = join(SESSIONS_DIR, childId)
  if (existsSync(direct)) return direct
  let projects = []
  try {
    projects = await readdir(SESSIONS_DIR)
  } catch {
    return undefined
  }
  for (const project of projects) {
    const candidate = join(SESSIONS_DIR, project, childId)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * 删除一个子智能体的会话：把它的会话目录整体移入插件回收目录。
 * 会话目录里是 `session.vN.jsonl.zstd` 这一代日志，`sessionQuery` 与侧栏
 * 会话列表都以它为真源，移走即从表单与列表消失；移入回收目录而不是 rm，
 * 保证误删可恢复。
 */
async function deleteSession(ctx, rootId, childId) {
  const dir = await findSessionDir(childId)
  if (dir === undefined) return { ok: false, reason: 'log-not-found' }
  await mkdir(TRASH_DIR, { recursive: true })
  const target = join(TRASH_DIR, `${Date.now()}-${childId}`)
  await rename(dir, target)
  try {
    await writeFile(
      join(target, 'child-control-note.json'),
      JSON.stringify({ sessionId: childId, rootSessionId: rootId, deletedAt: new Date().toISOString(), from: dir }, null, 2),
      'utf8',
    )
  } catch {
    /* 备注写失败不影响删除结论。 */
  }
  return { ok: true, trashedTo: target }
}

export function apply(ctx) {
  const log = (level, ...args) => {
    try {
      const logger = ctx.logger
      if (logger !== undefined && typeof logger[level] === 'function') logger[level](...args)
    } catch {
      /* 日志失败不得影响控制流 */
    }
  }
  const cascading = new Set()

  const route = (path, handler) => ctx.webServer.register({
    kind: 'exact',
    path: PREFIX + path,
    handler: async (req, res) => {
      try {
        // 纵深防御：这些路由能真正释放子智能体、移走会话日志，因此只接受本机
        // 回环来源。当前 webServer 默认绑 127.0.0.1，本检查用于 host: 0.0.0.0
        // 或反向代理场景下不把破坏性能力暴露到局域网。
        if (!isLoopback(req)) {
          json(res, { ok: false, error: 'forbidden', message: 'dsh-child-control routes accept loopback requests only' }, 403)
          return
        }
        const result = await handler(req, res)
        if (res.writableEnded !== true && result !== undefined) json(res, result)
      } catch (error) {
        if (res.writableEnded === true) return
        const status = Number.isInteger(error?.status) ? error.status : 500
        json(res, { ok: false, error: error?.error ?? 'internal', message: messageOf(error) }, status)
      }
    },
  })

  ctx.effect(() => {
    const disposers = []

    disposers.push(route('/tree', async req => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const sessionId = idOf(url.searchParams.get('sessionId'))
      if (sessionId === '') throw Object.assign(new Error('sessionId is required'), { status: 400, error: 'bad-request' })
      const tree = await readTree(ctx, sessionId)
      return { ok: true, build: BUILD, provider: DEFAULT_PROVIDER, ...tree }
    }))

    disposers.push(route('/stop-all', async req => {
      const body = await readBody(req)
      if (body === null) throw Object.assign(new Error('invalid JSON body'), { status: 400, error: 'bad-request' })
      const sessionId = idOf(body.sessionId)
      if (sessionId === '') throw Object.assign(new Error('sessionId is required'), { status: 400, error: 'bad-request' })
      const tree = await readTree(ctx, sessionId)
      const targets = new Set(tree.rows.map(row => row.id))
      if (body.includeRoot === true) targets.add(sessionId)
      // 作业必须以活着的 owner 作为授权者调用 kill，因此先于 Agent 释放执行。
      const jobs = body.killJobs === false ? [] : await stopJobs(ctx, sessionId, true)
      const stop = await stopNodes(ctx, sessionId, targets)
      log('info', `[dsh-child-control] stop-all ${sessionId}: ${stop.before} target(s), ${stop.stillLive.length} still live`)
      return { ok: true, ...stop, jobs }
    }))

    disposers.push(route('/stop', async req => {
      const body = await readBody(req)
      if (body === null) throw Object.assign(new Error('invalid JSON body'), { status: 400, error: 'bad-request' })
      const sessionId = idOf(body.sessionId)
      const childId = idOf(body.childId)
      if (sessionId === '' || childId === '') {
        throw Object.assign(new Error('sessionId and childId are required'), { status: 400, error: 'bad-request' })
      }
      if (childId === sessionId) throw Object.assign(new Error('the root session cannot be stopped here'), { status: 400, error: 'root-target' })
      const tree = await readTree(ctx, sessionId)
      const targets = new Set([childId])
      if (body.includeDescendants !== false) {
        for (const row of tree.rows) {
          if (row.depth > 0 && row.id !== childId) {
            let parent = row.parentId
            let guard = 0
            while (parent !== undefined && guard < 64) {
              if (parent === childId) { targets.add(row.id); break }
              const next = tree.rows.find(candidate => candidate.id === parent)
              parent = next?.parentId
              guard += 1
            }
          }
        }
      }
      const stop = await stopNodes(ctx, sessionId, targets)
      return { ok: true, ...stop }
    }))

    disposers.push(route('/add', async req => {
      const body = await readBody(req)
      if (body === null) throw Object.assign(new Error('invalid JSON body'), { status: 400, error: 'bad-request' })
      const sessionId = idOf(body.sessionId)
      if (sessionId === '') throw Object.assign(new Error('sessionId is required'), { status: 400, error: 'bad-request' })
      const { agents, subagents } = services(ctx)
      if (typeof subagents?.startActivation !== 'function') {
        throw Object.assign(new Error('ctx.subagents.startActivation is unavailable'), { status: 503, error: 'subagents-unavailable' })
      }
      const parent = agents?.get?.(sessionId)
      if (parent === undefined) {
        throw Object.assign(new Error(`session "${sessionId}" has no live agent; open it once before adding children`), {
          status: 409,
          error: 'session-not-attached',
        })
      }
      const label = text(body.label, 80) || '子智能体'
      const prompt = text(body.prompt, 200_000) || BOOTSTRAP_PROMPT
      const provider = text(body.provider, 40) || DEFAULT_PROVIDER
      const started = await subagents.startActivation({
        provider,
        label,
        request: { prompt: [{ type: 'text', text: prompt }], parent },
        signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
        delivery: 'parent',
      })
      log('info', `[dsh-child-control] added child ${started.childId} under ${sessionId} via ${provider}`)
      return { ok: true, childId: String(started.childId), messageId: started.messageId ? String(started.messageId) : null, provider }
    }))

    disposers.push(route('/prompt', async req => {
      const body = await readBody(req)
      if (body === null) throw Object.assign(new Error('invalid JSON body'), { status: 400, error: 'bad-request' })
      const sessionId = idOf(body.sessionId)
      const childId = idOf(body.childId)
      const content = text(body.text, 200_000)
      if (sessionId === '' || childId === '') {
        throw Object.assign(new Error('sessionId and childId are required'), { status: 400, error: 'bad-request' })
      }
      if (content === '') throw Object.assign(new Error('text is required'), { status: 400, error: 'bad-request' })
      const { agents, subagents } = services(ctx)
      if (typeof subagents?.prompt !== 'function') {
        throw Object.assign(new Error('ctx.subagents.prompt is unavailable'), { status: 503, error: 'subagents-unavailable' })
      }
      if (agents?.get?.(sessionId) === undefined) {
        throw Object.assign(new Error(`session "${sessionId}" is not live`), { status: 409, error: 'session-not-attached' })
      }
      const receipt = await subagents.prompt({
        requestId: randomUUID(),
        parentSessionId: sessionId,
        childSessionId: childId,
        mode: 'continuable',
        delivery: body.delivery === 'steer' ? 'steer' : 'queue',
        content: [{ type: 'text', text: content }],
      }, AbortSignal.timeout(CONTROL_TIMEOUT_MS))
      return { ok: true, messageId: String(receipt.messageId) }
    }))

    disposers.push(route('/session/delete', async req => {
      const body = await readBody(req)
      if (body === null) throw Object.assign(new Error('invalid JSON body'), { status: 400, error: 'bad-request' })
      const sessionId = idOf(body.sessionId)
      const childId = idOf(body.childId)
      if (sessionId === '' || childId === '') {
        throw Object.assign(new Error('sessionId and childId are required'), { status: 400, error: 'bad-request' })
      }
      if (childId === sessionId) {
        throw Object.assign(new Error('refusing to delete the root session'), { status: 400, error: 'root-target' })
      }
      const tree = await readTree(ctx, sessionId)
      if (!tree.rows.some(row => row.id === childId)) {
        throw Object.assign(new Error(`"${childId}" is not a descendant of "${sessionId}"`), { status: 403, error: 'not-a-descendant' })
      }
      if (body.stopFirst !== false) await stopNodes(ctx, sessionId, new Set([childId]))
      const after = await readTree(ctx, sessionId)
      const stillLive = after.rows.find(row => row.id === childId)?.live === true
      if (stillLive) {
        throw Object.assign(new Error('the child is still live after the stop request; retry once it is idle'), {
          status: 409,
          error: 'still-live',
        })
      }
      const deleted = await deleteSession(ctx, sessionId, childId)
      if (!deleted.ok) {
        throw Object.assign(new Error(`no session log found for "${childId}"`), { status: 404, error: deleted.reason })
      }
      log('info', `[dsh-child-control] deleted session ${childId} → ${deleted.trashedTo}`)
      return { ok: true, trashedTo: deleted.trashedTo }
    }))

    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* 幂等卸载 */
        }
      }
    }
  }, 'dsh-child-control: routes')

  if (CASCADE && typeof ctx.on === 'function') {
    ctx.effect(() => ctx.on('session/event', (session, event) => {
      if (event?.type !== 'turn/end') return
      const reason = event.data?.reason
      if (reason?.kind !== 'aborted' || reason?.reason?.kind !== 'user') return
      if (session?.header?.parentSession !== undefined) return
      const rootId = String(session.id)
      if (cascading.has(rootId)) return
      cascading.add(rootId)
      void (async () => {
        try {
          const tree = await readTree(ctx, rootId)
          if (tree.rows.length === 0) return
          await stopJobs(ctx, rootId, false)
          const stop = await stopNodes(ctx, rootId, new Set(tree.rows.map(row => row.id)))
          log('info', `[dsh-child-control] cascaded session stop of ${rootId}: ${stop.before} child(ren) stopped`)
        } catch (error) {
          log('warn', `[dsh-child-control] cascade failed for ${rootId}: ${messageOf(error)}`)
        } finally {
          cascading.delete(rootId)
        }
      })()
    }), 'dsh-child-control: cascade on user stop')
  }
}
