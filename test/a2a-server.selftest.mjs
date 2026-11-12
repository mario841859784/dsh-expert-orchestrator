// M1 自测：A2A 最小 HTTP 服务端（tools/a2a_taskboard.py，exposure-crypto-trust 报告 §5.4）
// （node:test，零依赖——服务端为 python3 标准库实现，本文件用 node:http 裸请求驱动全链）。
// 覆盖面：
// - 发现面：GET /.well-known/agent-card.json 卡形状（protocolVersion 0.3.0/preferredTransport
//   JSONRPC/capabilities 全 false/securitySchemes bearer/skills/dsh:* 元数据/url=实际端点）；
//   GET 其他路径 404。
// - 鉴权三件（MCP transports 最低配，报告「鉴权先于暴露」）：bearer 缺失/错误 → 401 +
//   WWW-Authenticate；Origin 白名单 MUST（缺省空名单=带 Origin 一律拒；--allow-origin 扩白）；
//   Host 头 rebinding 纵深校验（evil.com → 403）。
// - JSON-RPC 层：parse error -32700（400）/invalid request -32600/通知 202 无回包/
//   未知 method -32601/streaming 类 -32004/push 配置族 -32003。
// - message/send 写链（DSH_TASKBOARD_A2A_WRITES=1）：建任务 → A2A task 对象形状
//   （id/contextId/kind/status/metadata dsh:* 对账键）；板面真断言；状态映射
//   ready→submitted/running→working/done→completed；参数校验面（-32602/-32005/-32004）；
//   写面缺省关（writes_disabled 具名拒）+ 读面不受影响。
// - 阻塞语义（v1.0 §3.2 规范缺省阻塞）：外部 done 推进到终态 → 阻塞中的 send 返回
//   completed；超时如实返回当前非终态（文件板无服务端执行体的如实偏差）。
// - 启动面：token 未配置时生成 a2a-<32hex> 并 stderr 横幅打印；显式提供不回显。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const TOOLS_DIR = fileURLToPath(new URL('../skills/expert-orchestration/tools/', import.meta.url))
const A2A = join(TOOLS_DIR, 'a2a_taskboard.py')
const TB = join(TOOLS_DIR, 'taskboard.py')

/** 直跑 taskboard.py（与服务端同 cwd → 同一块缺省板），--json 信封解析。 */
const tb = (cwd, args) => {
  const r = spawnSync('python3', [TB, ...args], { cwd, encoding: 'utf-8' })
  let json = null
  try { json = JSON.parse((r.stdout ?? '').trim()) } catch { /* 人读面 */ }
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', json }
}

/** 裸 http.request 驱动（Host/Origin/Authorization 全可控，不依赖 fetch 的头策略）。 */
const rawRequest = (urlStr, { method = 'GET', headers = {}, body = null, timeoutMs = 15000 } = {}) =>
  new Promise((resolve, reject) => {
    const u = new URL(urlStr)
    const hdrs = { ...headers }
    if (body !== null) hdrs['Content-Length'] = Buffer.byteLength(body)
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: hdrs }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        let json = null
        try { json = data ? JSON.parse(data) : null } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text: data, json })
      })
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timeout ${timeoutMs}ms`)))
    req.on('error', reject)
    if (body !== null) req.write(body)
    req.end()
  })

const rpcBody = (id, method, params) =>
  JSON.stringify(id === null ? { jsonrpc: '2.0', method, ...(params ? { params } : {}) } : { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })

/** 启动服务端（临时端口），解析 stderr 横幅拿 url 与生效 token（生成态取横幅值；env/--token
 * 配置态回读测试侧配置——服务端不回显显式凭证）。resolve 条件=LISTEN 行且凭证行到齐
 * （REVIEW-ef3b962 必改-1②：服务端已把凭证行先于 LISTEN 打印，这里再等齐——负载下
 * stderr 分块到达也不会在凭证行缺席时 resolve，门禁不再间歇假红）。 */
const startServer = (t, cwd, { env = {}, args = [] } = {}) => new Promise((resolve, reject) => {
  let settled = false
  const proc = spawn('python3', [A2A, '--port', '0', ...args], { cwd, env: { ...process.env, ...env } })
  let stderr = ''
  proc.stderr.on('data', (d) => {
    if (settled) return
    stderr += d.toString()
    const listen = stderr.match(/A2A_LISTEN (\S+)/)
    if (!listen) return
    const tokenReady = /^A2A_TOKEN /m.test(stderr) // 生成态 a2a-xxx 或 显式态「A2A_TOKEN 来源=…」
    if (!tokenReady) return
    settled = true
    const generated = (stderr.match(/^A2A_TOKEN (a2a-[0-9a-f]{32})$/m) || [])[1] ?? null
    const fromFlag = (() => { const i = args.indexOf('--token'); return i >= 0 ? args[i + 1] : null })()
    const token = generated ?? fromFlag ?? env.DSH_TASKBOARD_A2A_TOKEN ?? null
    resolve({ proc, url: listen[1], token, generatedToken: generated, stderr })
  })
  proc.once('exit', (code) => { if (!settled) reject(new Error(`server 提前退出 code=${code}: ${stderr}`)) })
  t.after(() => { try { proc.kill('SIGTERM') } catch { /* 已退 */ } })
})

const makeDir = (t, label) => {
  const dir = mkdtempSync(join(tmpdir(), `m1-a2a-${label}-`))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const post = (url, token, body, opts = {}) => rawRequest(url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(token !== null && token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
    ...(opts.headers || {}),
  },
  body,
  timeoutMs: opts.timeoutMs,
})

test('M1-卡面 GET /.well-known/agent-card.json：v0.3.0 形状 + N1 安全声明 + url=实际端点；其他 GET 404', async (t) => {
  const dir = makeDir(t, 'card')
  const { url } = await startServer(t, dir)
  const card = await rawRequest(`${url}.well-known/agent-card.json`)
  assert.equal(card.status, 200)
  assert.equal(card.json.protocolVersion, '0.3.0')
  assert.equal(card.json.preferredTransport, 'JSONRPC', 'v0.3.0 卡必备字段（M1 部署 JSONRPC 传输）')
  assert.equal(card.json.url, url, '卡 url=实际绑定端点（可核查承诺）')
  assert.deepEqual(card.json.capabilities, { streaming: false, pushNotifications: false, stateTransitionHistory: false }, 'streaming/push 照实 false')
  assert.equal(card.json.securitySchemes.bearer.type, 'http')
  assert.equal(card.json.securitySchemes.bearer.scheme, 'bearer')
  assert.deepEqual(card.json.security, [{ bearer: [] }])
  assert.ok(Array.isArray(card.json.skills) && card.json.skills.length >= 1, `skills 非空：${card.json.skills?.length}`)
  assert.ok(['deployed-merged', 'bundled-core-fallback'].includes(card.json['dsh:rosterSource']))
  assert.ok(card.json['dsh:writeFace'].includes('DSH_TASKBOARD_A2A_WRITES'), '写面 opt-in 如实声明')
  assert.ok(card.json['dsh:blocking'].includes('returnImmediately'), '阻塞语义如实声明')
  const other = await rawRequest(`${url}nope`)
  assert.equal(other.status, 404)
  const root = await rawRequest(url)
  assert.equal(root.status, 404, 'GET / 404（JSON-RPC 端点=POST /）')
})

test('M1-鉴权三件：bearer 401+WWW-Authenticate / Origin 白名单 MUST（缺省空名单全拒）/ Host 纵深校验', async (t) => {
  const dir = makeDir(t, 'auth')
  const { url, token } = await startServer(t, dir, { env: { DSH_TASKBOARD_A2A_TOKEN: 'fixtok' } })
  // 认证：缺失/错误 → 401 + WWW-Authenticate: Bearer
  const noAuth = await post(url, null, rpcBody(1, 'tasks/get', { id: 'T1' }))
  assert.equal(noAuth.status, 401)
  assert.equal(noAuth.headers['www-authenticate'], 'Bearer')
  const badAuth = await post(url, 'wrong-token', rpcBody(1, 'tasks/get', { id: 'T1' }))
  assert.equal(badAuth.status, 401)
  // Host 纵深：rebinding 域名 Host → 403（带合法 token 亦拒）
  const evilHost = await post(url, 'fixtok', rpcBody(1, 'tasks/get', { id: 'T1' }), { headers: { Host: 'evil.com' } })
  assert.equal(evilHost.status, 403, JSON.stringify(evilHost.json))
  // Origin MUST：带 Origin 不在白名单（缺省空名单）→ 403
  const evilOrigin = await post(url, 'fixtok', rpcBody(1, 'tasks/get', { id: 'T1' }), { headers: { Origin: 'http://evil.com' } })
  assert.equal(evilOrigin.status, 403, JSON.stringify(evilOrigin.json))
  // 正常路径：合法 token + 无 Origin（非浏览器客户端）→ 200
  const ok = await post(url, 'fixtok', rpcBody(1, 'tasks/get', { id: 'T1' }))
  assert.equal(ok.status, 200)
  // --allow-origin 扩白后：卡面 GET 带 Origin 可达
  const { url: url2 } = await startServer(t, makeDir(t, 'auth2'), {
    env: { DSH_TASKBOARD_A2A_TOKEN: 'fixtok' },
    args: ['--allow-origin', 'http://localhost:5173'],
  })
  const allowed = await rawRequest(`${url2}.well-known/agent-card.json`, { headers: { Origin: 'http://localhost:5173' } })
  assert.equal(allowed.status, 200)
  const stillBlocked = await rawRequest(`${url2}.well-known/agent-card.json`, { headers: { Origin: 'http://evil.com' } })
  assert.equal(stillBlocked.status, 403)
})

test('M1-JSON-RPC 层：parse -32700(400) / invalid request -32600 / 通知 202 / method 族具名错', async (t) => {
  const dir = makeDir(t, 'rpc')
  const { url, token } = await startServer(t, dir, { env: { DSH_TASKBOARD_A2A_TOKEN: 'fixtok' } })
  const parseErr = await post(url, token, 'not json at all')
  assert.equal(parseErr.status, 400)
  assert.equal(parseErr.json.error.code, -32700)
  const invalid = await post(url, token, JSON.stringify({ id: 1, method: 42 }))
  assert.equal(invalid.status, 400)
  assert.equal(invalid.json.error.code, -32600)
  const notify = await rawRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fixtok' },
    body: rpcBody(null, 'ping'),
  })
  assert.equal(notify.status, 202)
  assert.equal(notify.text, '', '通知无回包')
  const unknown = await post(url, token, rpcBody(1, 'no/such/method'))
  assert.equal(unknown.status, 200)
  assert.equal(unknown.json.error.code, -32601)
  const stream = await post(url, token, rpcBody(2, 'message/stream', { message: { messageId: 'm', parts: [{ kind: 'text', text: 'x' }] } }))
  assert.equal(stream.json.error.code, -32004, 'streaming=false → UnsupportedOperationError')
  const push = await post(url, token, rpcBody(3, 'tasks/pushNotificationConfig/set', { id: 'T1' }))
  assert.equal(push.json.error.code, -32003, 'push=false → PushNotificationNotSupportedError')
  const cancel = await post(url, token, rpcBody(4, 'tasks/cancel', { id: 'T1' }))
  assert.equal(cancel.json.error.code, -32004, 'MVP 不含 tasks/cancel')
})

test('M1-message/send 写链：建任务 + A2A task 形状 + 板面真断言 + 状态映射 + tasks/get', async (t) => {
  const dir = makeDir(t, 'send')
  const { url, token } = await startServer(t, dir, { env: { DSH_TASKBOARD_A2A_WRITES: '1', DSH_TASKBOARD_A2A_TOKEN: 'fixtok' } })
  const r = await post(url, token, rpcBody(1, 'message/send', {
    message: { role: 'user', messageId: 'm-1', parts: [{ kind: 'text', text: 'hermes 派工任务\n验收：跨进程建任务成功' }] },
    configuration: { returnImmediately: true },
  }))
  assert.equal(r.status, 200, r.text)
  const task = r.json.result
  assert.equal(task.id, 'T1')
  assert.equal(task.kind, 'task')
  assert.equal(task.contextId, 'dsh-T1', '客户端未给 contextId → 按任务派生')
  assert.equal(task.status.state, 'submitted', 'ready → submitted')
  assert.equal(task.metadata['dsh:boardStatus'], 'ready', '板面原始状态如实回显（对账面）')
  assert.equal(task.metadata['dsh:eventSeq'], 1)
  assert.equal(task.metadata['dsh:revision'], 1)
  assert.equal(task.metadata['dsh:messageId'], 'm-1')
  assert.equal(task.metadata['dsh:owner'], '')
  // 板面真断言：标题=首行、完成标准=其余行
  const board = tb(dir, ['--json', 'show', 'T1'])
  assert.equal(board.json.ok, true)
  assert.equal(board.json.data.task.title, 'hermes 派工任务')
  assert.equal(board.json.data.task.desc, '验收：跨进程建任务成功')
  // contextId 客户端提供 → 原样回显
  const r2 = await post(url, token, rpcBody(2, 'message/send', {
    message: { role: 'user', messageId: 'm-2', contextId: 'conv-9', parts: [{ kind: 'text', text: '第二笔' }] },
    configuration: { returnImmediately: true },
  }))
  assert.equal(r2.json.result.contextId, 'conv-9')
  assert.equal(r2.json.result.id, 'T2')
  // 状态映射：claim → working；done → completed（tasks/get 轮询面）
  assert.equal(tb(dir, ['claim', 'T1', '专家甲']).code, 0)
  const poll1 = await post(url, token, rpcBody(3, 'tasks/get', { id: 'T1' }))
  assert.equal(poll1.json.result.status.state, 'working')
  assert.equal(poll1.json.result.metadata['dsh:boardStatus'], 'running')
  assert.equal(tb(dir, ['done', 'T1', '交付完成', '--by', '专家甲']).code, 0)
  const poll2 = await post(url, token, rpcBody(4, 'tasks/get', { id: 'T1' }))
  assert.equal(poll2.json.result.status.state, 'completed')
  // 未知 id → -32001 TaskNotFoundError
  const nf = await post(url, token, rpcBody(5, 'tasks/get', { id: 'T99' }))
  assert.equal(nf.json.error.code, -32001)
  assert.ok(nf.json.error.message.includes('T99'))
})

test('M1-message/send 校验面：缺 messageId/非 text part/空标题/taskId 续话 → 具名错', async (t) => {
  const dir = makeDir(t, 'valid')
  const { url, token } = await startServer(t, dir, { env: { DSH_TASKBOARD_A2A_WRITES: '1', DSH_TASKBOARD_A2A_TOKEN: 'fixtok' } })
  const noMid = await post(url, token, rpcBody(1, 'message/send', { message: { role: 'user', parts: [{ kind: 'text', text: 'x' }] } }))
  assert.equal(noMid.json.error.code, -32602)
  const filePart = await post(url, token, rpcBody(2, 'message/send', {
    message: { role: 'user', messageId: 'm', parts: [{ kind: 'file', file: { name: 'a.bin' } }] },
  }))
  assert.equal(filePart.json.error.code, -32005, '非 text part → ContentTypeNotSupportedError')
  const emptyTitle = await post(url, token, rpcBody(3, 'message/send', {
    message: { role: 'user', messageId: 'm', parts: [{ kind: 'text', text: '\n首行为空' }] },
  }))
  assert.equal(emptyTitle.json.error.code, -32602)
  const cont = await post(url, token, rpcBody(4, 'message/send', {
    message: { role: 'user', messageId: 'm', taskId: 'T1', parts: [{ kind: 'text', text: '续话' }] },
  }))
  assert.equal(cont.json.error.code, -32004)
  assert.ok(cont.json.error.message.includes('task_continuation_unsupported'))
  const noParts = await post(url, token, rpcBody(5, 'message/send', { message: { role: 'user', messageId: 'm', parts: [] } }))
  assert.equal(noParts.json.error.code, -32602)
  // 板面拒绝（taskboard 门禁）→ -32602 透传具名细节
  const dup = await post(url, token, rpcBody(6, 'message/send', {
    message: { role: 'user', messageId: 'm', parts: [{ kind: 'text', text: 'x' }] },
    metadata: { 'dsh:scope': 'src' },
    configuration: { returnImmediately: true }, // 合法请求会建任务——立即返回避免进入缺省阻塞轮询
  }))
  assert.equal(dup.json.result.id, 'T1', 'metadata dsh:scope 透传 create')
  // 空板重建场景太重——直接用 metadata dsh:owner 断言归属面：
  const own = await post(url, token, rpcBody(7, 'message/send', {
    message: { role: 'user', messageId: 'm2', parts: [{ kind: 'text', text: '归属任务' }] },
    metadata: { 'dsh:owner': 'hermes' },
    configuration: { returnImmediately: true },
  }))
  assert.equal(own.json.result.id, 'T2')
  assert.equal(own.json.result.metadata['dsh:owner'], 'hermes')
  const board = tb(dir, ['--json', 'show', 'T2'])
  assert.equal(board.json.data.task.owner, 'hermes', 'metadata dsh:owner → create --owner（自报口径）')
  // 中-2（REVIEW-ef3b962-security）：首行 '-' 开头的标题经 `--` 分隔保护原样落板
  //（无防护时 argparse 把它当旗标 → 误拒；未来 create 旗标扩展下静默注入）
  const dash = await post(url, token, rpcBody(8, 'message/send', {
    message: { role: 'user', messageId: 'm-dash', parts: [{ kind: 'text', text: '-开头的标题行' }] },
    configuration: { returnImmediately: true },
  }))
  assert.equal(dash.status, 200, dash.text)
  assert.equal(dash.json.result.id, 'T3')
  const dashBoard = tb(dir, ['--json', 'show', 'T3'])
  assert.equal(dashBoard.json.data.task.title, '-开头的标题行', `-- 保护后标题字面落板: ${dashBoard.json.data.task.title}`)
})

test('M1-写面缺省关：message/send 具名拒 writes_disabled；tasks/get 读面不受影响', async (t) => {
  const dir = makeDir(t, 'ro')
  tb(dir, ['create', '板上任务'])
  const { url, token } = await startServer(t, dir, { env: { DSH_TASKBOARD_A2A_TOKEN: 'fixtok' } })
  const r = await post(url, token, rpcBody(1, 'message/send', {
    message: { role: 'user', messageId: 'm', parts: [{ kind: 'text', text: '应被拒' }] },
  }))
  assert.equal(r.status, 200)
  assert.equal(r.json.error.code, -32004)
  assert.ok(r.json.error.message.includes('writes_disabled') && r.json.error.message.includes('DSH_TASKBOARD_A2A_WRITES'))
  const get = await post(url, token, rpcBody(2, 'tasks/get', { id: 'T1' }))
  assert.equal(get.json.result.id, 'T1', '读面缺省开放')
})

test('M1-阻塞语义：外部推进到终态 → 阻塞 send 返回 completed；超时如实返回当前非终态', async (t) => {
  const dir = makeDir(t, 'block')
  const { url, token } = await startServer(t, dir, { env: { DSH_TASKBOARD_A2A_WRITES: '1', DSH_TASKBOARD_A2A_TOKEN: 'fixtok' }, args: ['--block-max-sec', '3'] })
  const p = post(url, token, rpcBody(1, 'message/send', {
    message: { role: 'user', messageId: 'm-block', parts: [{ kind: 'text', text: '阻塞到终态' }] },
  }), { timeoutMs: 20000 })
  await new Promise((r2) => setTimeout(r2, 1200)) // 让 send 先建任务并进入轮询
  assert.equal(tb(dir, ['claim', 'T1', '专家乙']).code, 0)
  assert.equal(tb(dir, ['done', 'T1', '外部完成', '--by', '专家乙']).code, 0)
  const r = await p
  assert.equal(r.json.result.id, 'T1')
  assert.equal(r.json.result.status.state, 'completed', '缺省阻塞至终态（规范 MUST wait 落地）')
  assert.equal(r.json.result.metadata['dsh:boardStatus'], 'done')
  // 超时路径：无人推进 → 上限后如实返回当前非终态（submitted），不虚构终态
  const r2 = await post(url, token, rpcBody(2, 'message/send', {
    message: { role: 'user', messageId: 'm-timeout', parts: [{ kind: 'text', text: '无人推进' }] },
  }), { timeoutMs: 20000 })
  assert.equal(r2.json.result.status.state, 'submitted', '超时如实交回当前态（文件板无服务端执行体）')
  assert.ok(['ready', 'pending'].includes(r2.json.result.metadata['dsh:boardStatus']))
})

test('M1-启动面：token 未配置 → 生成 a2a-<32hex> 并横幅打印；显式提供不回显', async (t) => {
  const dir = makeDir(t, 'token')
  const { url, token, stderr } = await startServer(t, dir)
  assert.match(stderr, /A2A_TOKEN a2a-[0-9a-f]{32}/, '生成态横幅打印凭证（带外交给调用方）')
  assert.match(stderr, /A2A_TOKEN_NOTE/)
  const ok = await post(url, token, rpcBody(1, 'tasks/get', { id: 'T1' }))
  assert.equal(ok.status, 200, '生成 token 可用')
  const { stderr: stderr2 } = await startServer(t, makeDir(t, 'token2'), { env: { DSH_TASKBOARD_A2A_TOKEN: 'fixtok' } })
  assert.ok(!stderr2.includes('fixtok'), '显式提供不回显（不放大秘密面）')
  assert.match(stderr2, /A2A_TOKEN 来源=env\/--token/)
})
