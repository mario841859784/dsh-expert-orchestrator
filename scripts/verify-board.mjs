#!/usr/bin/env node
// M3 板外验证器（exposure-crypto-trust 报告 §5.10 验收标准）：独立进程、只持公钥验整板。
//
// 「签名不能只被写入方自己验证，否则与自报同层」——本验证器不持私钥、不写任何文件，
// 独立完成三件事：① 事件 hash 链逐条重算（复刻 taskboard.py _canonical 规范化字节面）；
// ② 事件签名逐条验（node:crypto/OpenSSL 独立实现——与 python vendored 实现互为双锚）；
// ③ 吊销比对（板根 revoked-keys）。异常即退出码 1（发现即报告，处置权在持有者）。
//
// 用法：node scripts/verify-board.mjs <board.json> [--keys <dir>] [--json] [--require-signed]
// - 事件流=<board>.events.jsonl；吊销=<board 所在目录>/revoked-keys（每行=base64 公钥全文，
//   空/缺失=空吊销集——显式不学 SSH 的 fail-closed 停用全体语义）；
// - 公钥面：--keys / env DSH_TASKBOARD_SIGN_PUBKEY_DIR / 缺省 ~/.dsh/keys；
// - 无签名事件（旧板/未开签名）如实计数为 unsigned，不判异常（模式混合是常态）；
//   **边界明示（REVIEW-ef3b962 建议2）**：攻击者若整板剥除 sig/sigkey 并重算 hash 链，
//   本验证器只以 unsigned 计数如实呈现、不判异常（「全部通过」≠「未被篡改」——签名剥除
//   需比对历史 unsigned 基线察觉；真源防改=报告 §4.5④ 声明不做）；`--require-signed`
//   收紧为「任何 unsigned 事件即异常 exit 1」（适用于已知全签名板的对账场景）；
// - 视图对账（REVIEW-ef3b962 建议1）：board.json 的 board_seq/revision 与事件流末事件
//   比对——事件流被删尾而视图未动（或反之）即判异常 exit 1（python load 路径 event_seq>
//   末 seq 防御的板外复刻）；board.json 缺失/损坏跳过对账（只验事件流本身）；
// - 退出码：0=链完整且全部带签事件验签通过；1=链断裂/invalid/revoked/unknown_key/
//   视图对账失配/（--require-signed 时）任一 unsigned。
//
// 规范化复刻边界（诚实声明）：python _canonical = json.dumps(ensure_ascii=False,
// sort_keys=True, separators=(',',':'))——node 侧按「键递归排序 + JSON.stringify 紧凑」
// 复刻，依赖三个事实：①事件/任务对象的键均为 ASCII（键序在两种排序口径下一致）；
// ②数值字段均为安全整数或 [0,1] 短小数（int 与最短浮点表示两语一致）；
// ③字符串值不含 U+2028/U+2029（python 原样输出、JS JSON.stringify 转义为 \u2028/2029
// ——两语字节面差异的理论边角，值域前提声明；REVIEW-ef3b962 建议6）。键集/数值域变化
// 时本复刻须重新对账（测试 board-signing.selftest 以 python 写板→node 验板互验钉死）。
import { createHash, createPublicKey, verify as ed25519Verify } from 'node:crypto'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'

const args = process.argv.slice(2)
const boardArg = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--keys')
const argOf = (flag) => {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined
}
const keysDirArg = argOf('--keys')
const jsonOut = args.includes('--json')
const requireSigned = args.includes('--require-signed')
const fail = (m) => { console.error(`错误：${m}`); process.exit(2) }

if (!boardArg) fail('用法：verify-board.mjs <board.json> [--keys <dir>] [--json]')
const boardPath = resolve(boardArg)
const eventsPath = `${boardPath}.events.jsonl`
if (!existsSync(eventsPath)) fail(`事件流不存在：${eventsPath}`)

// ── 规范化（python _canonical 字节面复刻）────────────────────────────────────
const canonical = (o) => {
  if (o === null || typeof o === 'boolean') return JSON.stringify(o)
  if (typeof o === 'number') return JSON.stringify(o)
  if (typeof o === 'string') return JSON.stringify(o)
  if (Array.isArray(o)) return `[${o.map(canonical).join(',')}]`
  const keys = Object.keys(o).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`
}
const sha256Hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
const eventHash = (ev) => sha256Hex(canonical(eventCanonBody(ev)))
// 签名/hash 的 canonical 输入=事件去 hash/sig 两键（与 taskboard.py _event_hash 同一面）
const eventCanonBody = (ev) => {
  const copy = { ...ev }
  delete copy.hash
  delete copy.sig
  return copy
}

// ── 公钥面与吊销面 ────────────────────────────────────────────────────────────
const keysDir = keysDirArg ?? process.env.DSH_TASKBOARD_SIGN_PUBKEY_DIR ?? join(homedir(), '.dsh', 'keys')
const keys = new Map() // 指纹 → 公钥 JWK
if (existsSync(keysDir)) {
  for (const fn of readdirSync(keysDir).sort()) {
    if (!fn.endsWith('.pub')) continue
    try {
      const pub = Buffer.from(readFileSync(join(keysDir, fn), 'utf-8').trim(), 'base64')
      if (pub.length !== 32) { console.error(`警告：公钥非 32 字节跳过（${join(keysDir, fn)}）`); continue }
      const fp = createHash('sha256').update(pub).digest('hex').slice(0, 16)
      keys.set(fp, createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pub.toString('base64url') }, format: 'jwk' }))
    } catch { console.error(`警告：公钥文件损坏跳过（${join(keysDir, fn)}）`) }
  }
}
const revokedFile = join(dirname(boardPath), 'revoked-keys')
const revokedFps = new Set()
if (existsSync(revokedFile)) {
  for (const ln of readFileSync(revokedFile, 'utf-8').split('\n')) {
    const s = ln.trim()
    if (!s) continue
    try {
      const pub = Buffer.from(s, 'base64')
      if (pub.length === 32) revokedFps.add(createHash('sha256').update(pub).digest('hex').slice(0, 16))
      else console.error(`警告：revoked-keys 行非 32 字节公钥跳过`)
    } catch { console.error(`警告：revoked-keys 行损坏跳过`) }
  }
}

// ── 逐事件验证 ────────────────────────────────────────────────────────────────
const raw = readFileSync(eventsPath, 'utf-8')
const lines = raw.split('\n').map((s) => s.trim()).filter(Boolean)
const events = []
let chainOk = true
let prevHash = ''
let prevSeq = 0
for (const s of lines) {
  let ev
  try { ev = JSON.parse(s) } catch { events.push({ seq: null, status: 'unparsable' }); chainOk = false; break }
  const hashOk = ev.hash === eventHash(ev) && ev.seq === prevSeq + 1 && ev.prev === prevHash && typeof ev.type === 'string'
  const fp = typeof ev.sigkey === 'string' ? ev.sigkey : null
  let sig
  if (!('sig' in ev)) sig = 'unsigned'
  else if (revokedFps.has(fp)) sig = 'revoked' // 吊销行自描述公钥，判定优先于公钥面收录与否
  else if (!keys.has(fp)) sig = 'unknown_key'
  else {
    const canon = canonical(eventCanonBody(ev))
    try {
      sig = ed25519Verify(null, Buffer.from(canon, 'utf8'), keys.get(fp), Buffer.from(ev.sig, 'base64')) ? 'verified' : 'invalid'
    } catch { sig = 'invalid' }
  }
  if (!hashOk) chainOk = false
  events.push({ seq: ev.seq ?? null, type: ev.type ?? null, hash: hashOk ? 'ok' : 'broken', sig, sigkey: fp })
  prevHash = ev.hash ?? ''
  prevSeq = ev.seq ?? prevSeq
}
const count = (k) => events.filter((e) => e.sig === k).length
// 视图对账（建议1）：board.json 的 seq/revision 应与事件流末事件一致（删尾/视图未随写即失配）；
// 视图缺失/损坏/事件流有不可解析行 → 跳过对账（只验事件流本身，如实注记）。
let viewAudit = { checked: false, reason: 'board.json 缺失或损坏（视图对账跳过，只验事件流）' }
try {
  const view = JSON.parse(readFileSync(boardPath, 'utf-8'))
  const lastEv = lines.map((s) => JSON.parse(s)).filter((e) => typeof e.seq === 'number').at(-1)
  if (lastEv) {
    const vseq = Number(view.seq ?? 0)
    const vrev = Number(view.revision ?? 0)
    const eseq = lastEv.board_seq ?? 0
    const erev = lastEv.revision ?? 0
    viewAudit = { checked: true, board_seq: vseq, event_board_seq: eseq, revision: vrev, event_revision: erev }
    if (vseq !== eseq || vrev !== erev) {
      viewAudit.mismatch = `视图 seq/revision=(${vseq},${vrev}) ≠ 事件流末事件=(${eseq},${erev})——事件流被删尾或视图未随写更新（python load 路径 event_seq>末 seq 防御的板外复刻）`
    }
  } else {
    viewAudit = { checked: false, reason: '事件流无带 seq 事件（空/异常流）' }
  }
} catch {
  /* 视图缺失/损坏或事件流含不可解析行：保持跳过注记（链面已另行判定） */
}
const summary = {
  events: events.length,
  chain: chainOk ? 'ok' : 'broken',
  keys: keys.size,
  revokedKeys: revokedFps.size,
  unsigned: count('unsigned'),
  verified: count('verified'),
  invalid: count('invalid'),
  revoked: count('revoked'),
  unknownKey: count('unknown_key'),
  view: viewAudit,
  requireSigned,
}
const anomalies = !chainOk || summary.invalid || summary.revoked || summary.unknownKey
  || events.some((e) => e.status === 'unparsable')
  || (viewAudit.checked && viewAudit.mismatch)
  || (requireSigned && summary.unsigned > 0)
const ok = !anomalies

if (jsonOut) {
  process.stdout.write(JSON.stringify({ board: boardPath, events, summary, ok }, null, 2) + '\n')
} else {
  console.log(`板外验证：${boardPath}`)
  console.log(`事件 ${summary.events} 条 | hash 链=${summary.chain} | 公钥 ${summary.keys} 把（吊销 ${summary.revokedKeys}）`)
  console.log(`签名面：unsigned=${summary.unsigned} verified=${summary.verified} invalid=${summary.invalid} revoked=${summary.revoked} unknown_key=${summary.unknownKey}${requireSigned ? ' | --require-signed（unsigned 即异常）' : ''}`)
  if (viewAudit.checked) console.log(`视图对账：${viewAudit.mismatch ?? `seq/revision=(${viewAudit.board_seq},${viewAudit.revision}) 与事件流末事件一致`}`)
  else console.log(`视图对账：跳过（${viewAudit.reason}）`)
  for (const e of events) {
    if (e.status === 'unparsable') console.log(`  [?] 行不可解析（链在此断裂）`)
    else if (e.hash !== 'ok' || (e.sig !== 'unsigned' && e.sig !== 'verified')) console.log(`  #${e.seq} ${e.type}: hash=${e.hash} sig=${e.sig}${e.sigkey ? ` key=${e.sigkey}` : ''}`)
  }
  const unsignedNote = summary.unsigned > 0 && !requireSigned
    ? '；注意：含 unsigned 事件——剥签重写不判异常（「全部通过」≠「未被篡改」，比对历史 unsigned 基线察觉）'
    : ''
  console.log(ok ? `结论：全部通过（链完整、带签事件验签一致）${unsignedNote}` : '结论：存在异常（见上）——链断裂/验签失败/吊销/未知落款/视图对账失配，处置权在持有者（签名不做执法）')
}
process.exit(ok ? 0 : 1)
