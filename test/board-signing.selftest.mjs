// M3 自测：Ed25519 事件签名 + 板外验证器（tools/_ed25519.py + taskboard.py 签名面 +
// scripts/board-keys.mjs + scripts/verify-board.mjs）（node:test，零依赖）。
// 正确性锚点（双实现互验，不依赖实现者自证）：
// - RFC 8032 §7.1 TEST 1 向量（sk/pk/sig 逐字节）+ L·B==单位元（群阶自检锚点）；
// - node:crypto（OpenSSL 独立实现）互签互验：python 签名 == node 签名（同 seed 同消息
//   逐字节）、node 验 python 签名、python 验 node 签名、公钥派生一致。
// 覆盖面：
// - taskboard.py 签名写入（DSH_TASKBOARD_SIGN_KEY opt-in）：事件带 sigkey+sig、hash 链
//   自洽；无签名缺省事件 JSON 无签名键（字节兼容）；replay --json sig_audit 载荷；
// - 折叠验签：verified/invalid（篡改 sig）/revoked（吊销行优先于公钥面收录）/
//   unknown_key/unsigned 计数 + stderr 标记不静默；签名不做执法（异常非 unrecoverable）；
// - 链篡改（改 args）仍按既有 unrecoverable 语义（签名不改执法归属）；
// - board-keys gen/fingerprint/pubkey；verify-board 板外验证器（python 写板 → node 验板）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const TOOLS_DIR = fileURLToPath(new URL('../skills/expert-orchestration/tools/', import.meta.url))
const TB = join(TOOLS_DIR, 'taskboard.py')
const ED = join(TOOLS_DIR, '_ed25519.py')
const KEYS = fileURLToPath(new URL('../scripts/board-keys.mjs', import.meta.url))
const VERIFY = fileURLToPath(new URL('../scripts/verify-board.mjs', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))

const runPy = (args, cwd, env = {}) => spawnSync('python3', args, { cwd, encoding: 'utf-8', env: { ...process.env, ...env } })
const runNode = (args, cwd, env = {}) => spawnSync('node', args, { cwd, encoding: 'utf-8', env: { ...process.env, ...env } })
const tb = (cwd, args, env = {}) => {
  const r = runPy([TB, ...args], cwd, env)
  let json = null
  try { json = JSON.parse((r.stdout ?? '').trim()) } catch { /* 多行人读面 */ }
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', json }
}

const makeDir = (t, label) => {
  const dir = mkdtempSync(join(tmpdir(), `m3-sign-${label}-`))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const eventsOf = (cwd) => readFileSync(join(cwd, '.expert-taskboards', 'default.json.events.jsonl'), 'utf-8')
  .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))

/** python 单行驱动 _ed25519（seed/pk/sig 均 base64 经 argv 传，输出 json 到 stdout）。 */
const ed = (script, args = []) => {
  const r = runPy(['-c', script, ...args], REPO_ROOT)
  assert.equal(r.status, 0, `python 驱动失败: ${r.stderr}`)
  return JSON.parse(r.stdout)
}

test('M3-跨实现互验：RFC 8032 TEST 1 向量 + L·B==单位元 + node（OpenSSL）互签互验', (t) => {
  // python 侧：RFC 向量 + 群阶自检 + 随机 seed 签名（输出交 node 复核）
  const out = ed(`
import sys, base64, json
sys.path.insert(0, ${JSON.stringify(TOOLS_DIR)})
import _ed25519 as e
def norm(P):
    x, y, z, tt = P
    zi = e._inv(z)
    return (x*zi % e.Q, y*zi % e.Q)
sk = bytes.fromhex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60')
pk_rfc = bytes.fromhex('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a')
sig_rfc = bytes.fromhex('e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b')
seed = bytes.fromhex(${JSON.stringify(Buffer.from(Array.from({length: 32}, (_, i) => i)).toString('hex'))})
msg = '中文消息 abc 123'.encode('utf-8')
pk_seed = e.publickey(seed)
sig_seed = e.signature(msg, seed, pk_seed)
print(json.dumps({
  'lb_identity': norm(e._scalarmult(e._BASE, e.L)) == (0, 1),
  'pk_rfc_match': e.publickey(sk) == pk_rfc,
  'sig_rfc_match': e.signature(b'', sk, pk_rfc) == sig_rfc,
  'verify_rfc': e.checkvalid(sig_rfc, b'', pk_rfc),
  'tamper_reject': not e.checkvalid(sig_rfc, b'x', pk_rfc),
  'seed': base64.b64encode(seed).decode(),
  'pk': base64.b64encode(pk_seed).decode(),
  'msg': base64.b64encode(msg).decode(),
  'sig': base64.b64encode(sig_seed).decode(),
  'py_verify_node_below': None,
}))
`)
  assert.equal(out.lb_identity, true, 'L·B==单位元（群阶常量自检锚点——2^252 加式写法抄错尾数的回归钉）')
  assert.equal(out.pk_rfc_match, true)
  assert.equal(out.sig_rfc_match, true)
  assert.equal(out.verify_rfc, true)
  assert.equal(out.tamper_reject, true)
  // node 侧（OpenSSL 独立实现）：公钥一致、签名逐字节一致、验 python 签名
  const b64url = (b) => Buffer.from(b, 'base64').toString('base64url')
  const r = runNode(['-e', `
const crypto = require('node:crypto')
const [seedB, pkB, msgB, sigB] = process.argv.slice(1)
const seed = Buffer.from(seedB, 'base64')
const p8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed])
const priv = crypto.createPrivateKey({ key: p8, format: 'der', type: 'pkcs8' })
const spki = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' })
const msg = Buffer.from(msgB, 'base64')
const sig = Buffer.from(sigB, 'base64')
const pubObj = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(pkB, 'base64').toString('base64url') }, format: 'jwk' })
console.log(JSON.stringify({
  pkMatch: spki.subarray(spki.length - 32).equals(Buffer.from(pkB, 'base64')),
  sigMatch: crypto.sign(null, msg, priv).equals(sig),
  verifyPySig: crypto.verify(null, msg, pubObj, sig),
}))
`, out.seed, out.pk, out.msg, out.sig])
  assert.equal(r.status, 0, r.stderr)
  const node = JSON.parse(r.stdout)
  assert.equal(node.pkMatch, true, 'node 公钥派生 == python（跨实现）')
  assert.equal(node.sigMatch, true, 'node 签名 == python 签名（同 seed 同消息逐字节）')
  assert.equal(node.verifyPySig, true, 'node 验 python 签名通过')
  // python 验 node 签名（反向）
  const r2 = runNode(['-e', `
const crypto = require('node:crypto')
const [seedB, msgB] = process.argv.slice(1)
const p8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seedB, 'base64')])
const priv = crypto.createPrivateKey({ key: p8, format: 'der', type: 'pkcs8' })
console.log(crypto.sign(null, Buffer.from(msgB, 'base64'), priv).toString('base64'))
`, out.seed, out.msg])
  const nodeSig = r2.stdout.trim()
  const r3 = runPy(['-c', `
import sys, base64, json
sys.path.insert(0, ${JSON.stringify(TOOLS_DIR)})
import _ed25519 as e
pk = base64.b64decode(${JSON.stringify(out.pk)})
sig = base64.b64decode(sys.argv[1])
msg = base64.b64decode(${JSON.stringify(out.msg)})
print(json.dumps({'ok': e.checkvalid(sig, msg, pk), 'tamper': not e.checkvalid(sig, msg + b'!', pk)}))
`, nodeSig])
  const py = JSON.parse(r3.stdout)
  assert.equal(py.ok, true, 'python 验 node 签名通过')
  assert.equal(py.tamper, true, 'python 验签对篡改消息拒绝')
})

test('M3-board-keys：gen（.key 0600/.pub）+ fingerprint 与事件落款同锚 + pubkey 导出', (t) => {
  const dir = makeDir(t, 'keys')
  const keysDir = join(dir, 'keys')
  const r = runNode([KEYS, 'gen', '--name', '编排者', '--out-dir', keysDir], dir)
  assert.equal(r.status, 0, r.stderr)
  assert.ok(r.stderr.includes('0600'), r.stderr)
  const keyPath = join(keysDir, '编排者.key')
  const pubPath = join(keysDir, '编排者.pub')
  assert.ok(existsSync(keyPath) && existsSync(pubPath))
  assert.equal(statSync(keyPath).mode & 0o777, 0o600, '私钥 0600')
  // 不覆盖既有私钥（never destroy）
  const r2 = runNode([KEYS, 'gen', '--name', '编排者', '--out-dir', keysDir], dir)
  assert.equal(r2.status, 1, '同名 gen 拒绝覆盖')
  // fingerprint 与 python 落款同锚
  const fp = runNode([KEYS, 'fingerprint', '--pub', pubPath], dir).stdout.trim()
  const pubB64 = readFileSync(pubPath, 'utf-8').trim()
  const pyFp = ed(`
import sys, base64, json, hashlib
sys.path.insert(0, ${JSON.stringify(TOOLS_DIR)})
print(json.dumps(hashlib.sha256(base64.b64decode(${JSON.stringify(pubB64)})).hexdigest()[:16]))
`)
  assert.equal(fp, pyFp, 'fingerprint 口径跨语言一致（sha256[:16]）')
  // pubkey 导出 == .pub 文件内容（补发面）
  assert.equal(runNode([KEYS, 'pubkey', '--key', keyPath], dir).stdout.trim(), pubB64)
})

test('M3-taskboard 签名写入：事件带 sigkey+sig、hash 链自洽、replay sig_audit verified；缺省无签名键（字节兼容）', (t) => {
  const dir = makeDir(t, 'write')
  const keysDir = join(dir, 'keys')
  assert.equal(runNode([KEYS, 'gen', '--name', '编排者', '--out-dir', keysDir], dir).status, 0)
  const env = { DSH_TASKBOARD_SIGN_KEY: join(keysDir, '编排者.key'), DSH_TASKBOARD_SIGN_PUBKEY_DIR: keysDir }
  assert.equal(tb(dir, ['create', '签名任务', '--owner', '甲'], env).code, 0)
  assert.equal(tb(dir, ['claim', 'T1', '乙'], env).code, 0)
  const evs = eventsOf(dir)
  assert.equal(evs.length, 2)
  for (const ev of evs) {
    assert.equal(typeof ev.sig, 'string', '事件带 sig')
    assert.equal(typeof ev.sigkey, 'string', '事件带 sigkey 落款指纹')
    assert.ok(ev.sig.length >= 80, 'Ed25519 签名 64 字节 base64 ≥80 字符')
  }
  const fp = runNode([KEYS, 'fingerprint', '--pub', join(keysDir, '编排者.pub')], dir).stdout.trim()
  assert.equal(evs[0].sigkey, fp, '事件落款指纹 == 密钥工具指纹（同锚）')
  // replay --json：折叠验签载荷（configured/verified/signed）
  const rp = tb(dir, ['--json', 'replay'], env)
  const audit = rp.json.data.sig_audit
  assert.equal(audit.configured, true)
  assert.equal(audit.signed, 2)
  assert.equal(audit.verified, 2)
  assert.deepEqual(audit.invalid, [])
  // 板外验证器（python 写板 → node 验板——canonical 复刻跨语言互验）
  const v = runNode([VERIFY, join(dir, '.expert-taskboards', 'default.json'), '--keys', keysDir], dir)
  assert.equal(v.status, 0, v.stdout + v.stderr)
  assert.ok(v.stdout.includes('verified=2'), v.stdout)
  // 缺省无签名：事件 JSON 无 sig/sigkey（字节兼容），audit configured:false 如实占位
  const dir2 = makeDir(t, 'unsigned')
  assert.equal(tb(dir2, ['create', '无签任务'], {}).code, 0)
  for (const ev of eventsOf(dir2)) {
    assert.equal('sig' in ev, false, '缺省事件无 sig 键')
    assert.equal('sigkey' in ev, false, '缺省事件无 sigkey 键')
  }
  const rp2 = tb(dir2, ['--json', 'replay'], {})
  assert.deepEqual(rp2.json.data.sig_audit, { configured: false }, '验签面未配置如实占位（≠验签通过）')
})

test('M3-篡改与吊销：sig 篡改→invalid 标记不静默（非 unrecoverable）；吊销行优先于公钥面；链篡改仍 unrecoverable', (t) => {
  const dir = makeDir(t, 'tamper')
  const keysDir = join(dir, 'keys')
  assert.equal(runNode([KEYS, 'gen', '--name', '编排者', '--out-dir', keysDir], dir).status, 0)
  const env = { DSH_TASKBOARD_SIGN_KEY: join(keysDir, '编排者.key'), DSH_TASKBOARD_SIGN_PUBKEY_DIR: keysDir }
  assert.equal(tb(dir, ['create', '篡改靶'], env).code, 0)
  const eventsFile = join(dir, '.expert-taskboards', 'default.json.events.jsonl')
  // ① 只篡改 sig（链 hash 不动）→ invalid 标记不静默，退出码 0（签名不做执法）
  const evs = eventsOf(dir)
  evs[0].sig = 'AAAA' + evs[0].sig.slice(4)
  writeFileSync(eventsFile, evs.map((e2) => JSON.stringify(e2)).join('\n') + '\n')
  const rp = tb(dir, ['--json', 'replay'], env)
  assert.equal(rp.code, 0, '签名异常不是 unrecoverable（不做执法）')
  assert.deepEqual(rp.json.data.sig_audit.invalid, [1], 'invalid 如实计数')
  assert.ok(rp.stderr.includes('验签异常'), 'stderr 标记不静默')
  // ② 吊销：revoked-keys 行=.pub 内容原文；判定优先（独立 keys 目录不含该钥也判 revoked）
  const otherKeys = join(dir, 'keys-empty')
  mkdirSync(otherKeys, { recursive: true })
  const envRev = { DSH_TASKBOARD_SIGN_KEY: join(keysDir, '编排者.key'), DSH_TASKBOARD_SIGN_PUBKEY_DIR: otherKeys }
  writeFileSync(join(dir, '.expert-taskboards', 'revoked-keys'), readFileSync(join(keysDir, '编排者.pub'), 'utf-8'))
  const rpRev = tb(dir, ['--json', 'replay'], envRev)
  assert.deepEqual(rpRev.json.data.sig_audit.revoked, [1], '吊销行自描述公钥——优先于 keys 面收录')
  assert.ok(rpRev.stderr.includes('revoked=1'), rpRev.stderr)
  // ③ unknown_key：签名合法但验签面不含落款钥——fresh dir 构造（sigkey 在 hash 链内，
  // 直接改落款会断链——hash 链覆盖落款指纹本身就是防「换钥冒名」的机制，测试遵循该语义）
  const dir4 = makeDir(t, 'unknown')
  const writerKeys = join(dir4, 'keys-writer')
  const faceKeys = join(dir4, 'keys-face') // 面存在但不收录写入钥（configured=true、keys=0）
  mkdirSync(faceKeys, { recursive: true })
  assert.equal(runNode([KEYS, 'gen', '--name', '她', '--out-dir', writerKeys], dir4).status, 0)
  const envW = { DSH_TASKBOARD_SIGN_KEY: join(writerKeys, '她.key'), DSH_TASKBOARD_SIGN_PUBKEY_DIR: faceKeys }
  assert.equal(tb(dir4, ['create', '未知落款靶'], envW).code, 0)
  const rpUnk = tb(dir4, ['--json', 'replay'], { DSH_TASKBOARD_SIGN_PUBKEY_DIR: faceKeys })
  assert.deepEqual(rpUnk.json.data.sig_audit.unknown_key, [1], '未知落款如实计数')
  assert.ok(rpUnk.stderr.includes('unknown_key=1'), rpUnk.stderr)
  // ④ 链篡改（改 args 不重算 hash）→ 既有 unrecoverable 语义不动（签名不改执法归属）
  const dir3 = makeDir(t, 'chain')
  assert.equal(tb(dir3, ['create', '链篡改靶'], env).code, 0)
  const evsC = eventsOf(dir3)
  evsC[0].args.title = '被篡改'
  writeFileSync(join(dir3, '.expert-taskboards', 'default.json.events.jsonl'), evsC.map((e2) => JSON.stringify(e2)).join('\n') + '\n')
  const broken = tb(dir3, ['--json', 'list'], env)
  assert.equal(broken.code, 1)
  assert.equal(broken.json.error, 'unrecoverable', '链/hash 校验失败仍 unrecoverable（既有语义）')
})

test('M3-verify-board --json 机读面 + 无签名板全 unsigned 退出码 0', (t) => {
  const dir = makeDir(t, 'verify')
  const keysDir = join(dir, 'keys')
  assert.equal(runNode([KEYS, 'gen', '--name', 'hermes', '--out-dir', keysDir], dir).status, 0)
  const env = { DSH_TASKBOARD_SIGN_KEY: join(keysDir, 'hermes.key'), DSH_TASKBOARD_SIGN_PUBKEY_DIR: keysDir }
  assert.equal(tb(dir, ['create', '验证器靶'], env).code, 0)
  const board = join(dir, '.expert-taskboards', 'default.json')
  const r = runNode([VERIFY, board, '--keys', keysDir, '--json'], dir)
  assert.equal(r.status, 0)
  const out = JSON.parse(r.stdout)
  assert.equal(out.ok, true)
  assert.equal(out.summary.verified, 1)
  assert.equal(out.summary.chain, 'ok')
  // 无签名板：unsigned 计数 + 退出码 0（模式混合是常态，不判异常）
  const dir2 = makeDir(t, 'verify-unsigned')
  assert.equal(tb(dir2, ['create', '无签验证靶'], {}).code, 0)
  const r2 = runNode([VERIFY, join(dir2, '.expert-taskboards', 'default.json'), '--keys', keysDir, '--json'], dir2)
  assert.equal(r2.status, 0, '无签名板不判异常')
  const out2 = JSON.parse(r2.stdout)
  assert.equal(out2.summary.unsigned, 1)
  assert.equal(out2.summary.verified, 0)
  assert.equal(out2.ok, true)
  // 事件流缺失 → exit 2（用法/资源错误面）
  const r3 = runNode([VERIFY, join(dir, 'no-such-board.json'), '--keys', keysDir], dir)
  assert.equal(r3.status, 2)
})
