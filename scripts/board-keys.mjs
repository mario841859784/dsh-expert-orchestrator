#!/usr/bin/env node
// M3 密钥工具（exposure-crypto-trust 报告 §4.3/§5.7）：Ed25519 密钥对生成（node crypto
// 零安装）。私钥=32 字节 seed（base64，0600），公钥=<name>.pub（base64）——预共享目录
// 载体（~/.dsh/keys 缺省）；公钥随目录分发，私钥不离开本机（会话密钥短命，吊销压力
// 在长命身份——报告 §4.3）。
//
// 用法：
//   node scripts/board-keys.mjs gen --name <agent> [--out-dir <dir>]   # 生成 <name>.key/.pub
//   node scripts/board-keys.mjs fingerprint --pub <file>               # 打印公钥指纹（落款/吊销对账锚）
//   node scripts/board-keys.mjs pubkey  --key <file>                   # 从私钥文件导出公钥（补发 .pub）
// 指纹口径：sha256(公钥 32 字节) 前 16 hex——与 taskboard.py 事件 sigkey 落款一致。
import { generateKeyPairSync, createHash } from 'node:crypto'
import { writeFileSync, readFileSync, mkdirSync, existsSync, statSync, chmodSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

const args = process.argv.slice(2)
const cmd = args[0]
const argOf = (flag) => {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined
}
const fingerprint = (pub) => createHash('sha256').update(pub).digest('hex').slice(0, 16)
const b64 = (buf) => Buffer.from(buf).toString('base64')

const DEFAULT_DIR = join(homedir(), '.dsh', 'keys')

const fail = (m) => { console.error(`错误：${m}`); process.exit(1) }

if (cmd === 'gen') {
  const name = argOf('--name')
  if (!name || /[\\/\s]/.test(name)) fail('--name 须为不含空白与路径分隔符的标识（如 编排者、hermes）')
  const outDir = resolve(argOf('--out-dir') ?? DEFAULT_DIR)
  const keyPath = join(outDir, `${name}.key`)
  const pubPath = join(outDir, `${name}.pub`)
  if (existsSync(keyPath)) fail(`私钥已存在（不覆盖——archive/back up, never destroy）：${keyPath}`)
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const jwk = privateKey.export({ format: 'jwk' })
  const seed = Buffer.from(jwk.d, 'base64url') // RFC 8032 私钥=32 字节 seed（node JWK d 位即 seed）
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url')
  if (seed.length !== 32 || pub.length !== 32) fail('密钥长度异常（内部错误）')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(keyPath, b64(seed) + '\n', { mode: 0o600 })
  writeFileSync(pubPath, b64(pub) + '\n')
  try { if ((statSync(keyPath).mode & 0o777) !== 0o600) chmodSync(keyPath, 0o600) } catch { /* 尽力收紧 */ }
  console.error(`密钥对生成：${keyPath}（0600，勿离开本机）+ ${pubPath}（分发面）`)
  console.error(`指纹 ${fingerprint(pub)}（事件 sigkey 落款/revoked-keys 对账锚）`)
  console.error(`接入：写入端 DSH_TASKBOARD_SIGN_KEY=${keyPath}；验证端目录 ${outDir}（或 env DSH_TASKBOARD_SIGN_PUBKEY_DIR）`)
} else if (cmd === 'fingerprint') {
  const pubFile = argOf('--pub')
  if (!pubFile) fail('fingerprint 须带 --pub <file>')
  const pub = Buffer.from(readFileSync(resolve(pubFile), 'utf-8').trim(), 'base64')
  if (pub.length !== 32) fail('公钥须为 32 字节 base64')
  process.stdout.write(fingerprint(pub) + '\n')
} else if (cmd === 'pubkey') {
  const keyFile = argOf('--key')
  if (!keyFile) fail('pubkey 须带 --key <file>')
  const raw = readFileSync(resolve(keyFile), 'utf-8').trim()
  const seed = Buffer.from(raw, 'base64')
  if (seed.length !== 32) fail('私钥须为 32 字节 seed 的 base64')
  const p8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed])
  const { createPrivateKey } = await import('node:crypto')
  const jwk = createPrivateKey({ key: p8, format: 'der', type: 'pkcs8' }).export({ format: 'jwk' })
  process.stdout.write(Buffer.from(jwk.x, 'base64url').toString('base64') + '\n')
} else {
  fail('用法：board-keys.mjs gen --name <agent> [--out-dir <dir>] | fingerprint --pub <file> | pubkey --key <file>')
}
