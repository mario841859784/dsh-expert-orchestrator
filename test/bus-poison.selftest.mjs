// test/bus-poison.selftest.mjs — 消息总线毒消息自愈自测（v2.13.1 T2，node:test，零依赖）。
// 场景：可解析但缺必备字段（message_invalid）的消息落在发件箱或收件箱时，
// send/flush（投递）、read（读取）、ack（确认）三路径均须：
//   1) 隔离为 <原名>.corrupt（os.replace，原文件内容逐字节保留，不删除不重写）；
//   2) stderr 具名告警（含「毒消息已隔离」与原文件名）；
//   3) 跳过该条继续处理其余消息——其余消息正常投递/读取/确认，命令退出码 0；
//   4) 发件箱投递游标不回退不前跳（毒条目不参与游标比较）。
// 对照组：截断 JSON 残件维持显式报错路径（flush/read 报错退出、不静默）。
// 全部用例跑在 tmp 根（mkdtemp），不触碰本仓任何真实信箱。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUS = join(repoRoot, 'skills', 'expert-orchestration', 'tools', 'bus.py')

function bus(args, root) {
  return spawnSync('python3', [BUS, '--root', root, ...args], { encoding: 'utf8' })
}

function makeRoot(tag) {
  return mkdtempSync(join(tmpdir(), `bus-poison-${tag}-`))
}

// 目录布局（bus.py 实测）：收件箱 = root/<box>/，发件箱 = root/_outbox/<sender>/
function outboxDir(root, sender) {
  return join(root, '_outbox', sender)
}
function inboxDir(root, box) {
  return join(root, box)
}

function listJson(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.json')).sort() : []
}

// 正常发一条消息，返回 subject 标记
function sendOk(root, from, box, subject) {
  const r = bus(['send', '--from', from, '--to', box, '--subject', subject, '--body', `正文:${subject}`], root)
  assert.equal(r.status, 0, `send 失败: ${r.stderr}`)
  return subject
}

// 写一条可解析但缺必备字段的毒消息（缺 from）
function writePoison(dir, name) {
  mkdirSync(dir, { recursive: true })
  const poison = JSON.stringify({ id: 'poison-1', to: 'receiver', ts: 1700000000000, body: '毒' })
  writeFileSync(join(dir, name), poison)
  return poison
}

// ── 投递路径：flush_outbox 隔离毒消息，其余正常投递，游标不回退 ────────────────
test('发件箱毒消息：flush 隔离 .corrupt 留痕，其余消息正常投递，游标不回退', () => {
  const root = makeRoot('flush')
  sendOk(root, 'sender', 'receiver', '第一封')
  const afterFirst = listJson(inboxDir(root, 'receiver'))
  assert.equal(afterFirst.length, 1)

  // 手工注入毒消息（可解析、缺 from）到发件箱，时间戳晚于已投递消息
  const poisonName = '1700000001000-poison-1.json'
  const poisonBody = writePoison(outboxDir(root, 'sender'), poisonName)

  // 再正常发一封（触发 flush；毒消息与其后的合法消息按名排序投递）
  sendOk(root, 'sender', 'receiver', '第二封')

  // 毒消息已隔离：.json 消失，.corrupt 存在且内容逐字节保留
  assert.equal(existsSync(join(outboxDir(root, 'sender'), poisonName)), false, '毒消息 .json 应已移出投递队列')
  const corruptPath = join(outboxDir(root, 'sender'), `${poisonName}.corrupt`)
  assert.ok(existsSync(corruptPath), '毒消息应隔离为 .corrupt')
  assert.equal(readFileSync(corruptPath, 'utf8'), poisonBody, '.corrupt 应逐字节保留原文件内容')

  // 合法消息照常投递（不受毒消息影响），毒消息不进收件箱
  const delivered = listJson(inboxDir(root, 'receiver'))
  assert.equal(delivered.length, 2, `应有 2 封已投递消息: ${delivered}`)
  const subjects = delivered.map((n) => JSON.parse(readFileSync(join(inboxDir(root, 'receiver'), n), 'utf8')).subject)
  assert.deepEqual(subjects.sort(), ['第一封', '第二封'])

  // 游标不回退：应指向最新一次投递（seq=2，毒条目 seq 缺失按 0 不参与比较）
  const cursor = JSON.parse(readFileSync(join(outboxDir(root, 'sender'), 'cursor.json'), 'utf8'))
  assert.equal(cursor.seq, 2, `游标应推进到第 2 封: ${JSON.stringify(cursor)}`)
  assert.ok(!String(cursor.name).includes('poison'), '游标不应指向毒消息')
  rmSync(root, { recursive: true, force: true })
})

test('发件箱毒消息：stderr 具名告警含文件名与「毒消息已隔离」，命令退出码 0', () => {
  const root = makeRoot('warn')
  writePoison(outboxDir(root, 'sender'), '1700000001000-poison-1.json')
  const r = bus(['send', '--from', 'sender', '--to', 'receiver', '--subject', '正常', '--body', 'x'], root)
  assert.equal(r.status, 0, `send 应成功: ${r.stderr}`)
  assert.match(r.stderr, /毒消息已隔离/)
  assert.match(r.stderr, /1700000001000-poison-1\.json/)
  assert.match(r.stderr, /缺失必备字段/)
  rmSync(root, { recursive: true, force: true })
})

test('发件箱毒消息：发送者后续 send 不再被卡死（毒条目已移出队列）', () => {
  const root = makeRoot('unstick')
  writePoison(outboxDir(root, 'sender'), '1700000001000-poison-1.json')
  // 第一次 send 触发 flush 隔离毒消息
  bus(['send', '--from', 'sender', '--to', 'receiver', '--subject', 'a', '--body', 'a'], root)
  // 第二次 send 不应有毒消息残留告警，投递正常
  const r2 = bus(['send', '--from', 'sender', '--to', 'receiver', '--subject', 'b', '--body', 'b'], root)
  assert.equal(r2.status, 0)
  assert.equal(r2.stderr, '', `第二次 send 不应有告警: ${r2.stderr}`)
  assert.equal(listJson(inboxDir(root, 'receiver')).length, 2)
  rmSync(root, { recursive: true, force: true })
})

// ── 读取路径：read_box 隔离毒消息，其余正常读取 ────────────────────────────────
test('收件箱毒消息：read 隔离 .corrupt 留痕并告警，其余消息正常读取', () => {
  const root = makeRoot('read')
  sendOk(root, 'sender', 'receiver', '正常一')
  // 注入毒消息到收件箱（可解析、缺 from）
  const poisonName = '1700000002000-poison-2.json'
  const poisonBody = writePoison(inboxDir(root, 'receiver'), poisonName)
  sendOk(root, 'sender', 'receiver', '正常二')

  const r = bus(['read', '--box', 'receiver', '--no-attempt-filter'], root)
  assert.equal(r.status, 0, `read 应成功: ${r.stderr}`)
  assert.match(r.stderr, /毒消息已隔离/)
  assert.match(r.stderr, /1700000002000-poison-2\.json/)
  // 两条合法消息都在读取结果里
  assert.match(r.stdout, /正常一/)
  assert.match(r.stdout, /正常二/)
  // 毒消息隔离为 .corrupt，内容逐字节保留
  assert.equal(existsSync(join(inboxDir(root, 'receiver'), poisonName)), false)
  const corruptPath = join(inboxDir(root, 'receiver'), `${poisonName}.corrupt`)
  assert.ok(existsSync(corruptPath), '毒消息应隔离为 .corrupt')
  assert.equal(readFileSync(corruptPath, 'utf8'), poisonBody, '.corrupt 应逐字节保留原文件内容')
  rmSync(root, { recursive: true, force: true })
})

// ── 确认路径：ack --all 隔离毒消息，其余正常确认 ──────────────────────────────
test('ack --all 毒消息：隔离并继续，其余消息全部确认置已读', () => {
  const root = makeRoot('ack')
  sendOk(root, 'sender', 'receiver', '待确认一')
  writePoison(inboxDir(root, 'receiver'), '1700000002000-poison-2.json')
  sendOk(root, 'sender', 'receiver', '待确认三')

  const r = bus(['ack', '--box', 'receiver', '--all'], root)
  assert.equal(r.status, 0, `ack 应成功: ${r.stderr}`)
  assert.match(r.stderr, /毒消息已隔离/)
  // 毒消息隔离，其余确认
  assert.ok(existsSync(join(inboxDir(root, 'receiver'), '1700000002000-poison-2.json.corrupt')))
  assert.equal(existsSync(join(inboxDir(root, 'receiver'), '1700000002000-poison-2.json')), false)
  // 其余消息 read=true
  for (const name of listJson(inboxDir(root, 'receiver'))) {
    const m = JSON.parse(readFileSync(join(inboxDir(root, 'receiver'), name), 'utf8'))
    assert.equal(m.read, true, `消息 ${name} 应已确认`)
  }
  rmSync(root, { recursive: true, force: true })
})

// ── 对照组：截断 JSON 残件维持既有路径（flush 自愈隔离 / read 显式报错），T2 不改 ──
test('发件箱截断 JSON 残件：flush 沿用既有自愈——隔离 .corrupt 告警后继续（非 T2 毒消息路径）', () => {
  const root = makeRoot('trunc')
  mkdirSync(outboxDir(root, 'sender'), { recursive: true })
  writeFileSync(join(outboxDir(root, 'sender'), '1700000001000-broken.json'), '{"id": "bro')
  const r = bus(['send', '--from', 'sender', '--to', 'receiver', '--subject', 'x', '--body', 'x'], root)
  assert.equal(r.status, 0, `截断残件走既有自愈，send 应成功: ${r.stderr}`)
  assert.match(r.stderr, /截断残件已隔离/, '应有既有截断自愈告警')
  // 既有自愈：原 .json 改名 .corrupt，正常消息照常投递
  assert.ok(existsSync(join(outboxDir(root, 'sender'), '1700000001000-broken.json.corrupt')))
  assert.equal(existsSync(join(outboxDir(root, 'sender'), '1700000001000-broken.json')), false)
  assert.equal(listJson(inboxDir(root, 'receiver')).length, 1)
  rmSync(root, { recursive: true, force: true })
})

test('收件箱截断 JSON 残件：read 显式报错退出（维持既有行为）', () => {
  const root = makeRoot('trunc-inbox')
  sendOk(root, 'sender', 'receiver', '正常')
  writeFileSync(join(inboxDir(root, 'receiver'), '1700000002000-broken.json'), '{"id": "bro')
  const r = bus(['read', '--box', 'receiver', '--no-attempt-filter'], root)
  assert.notEqual(r.status, 0, '收件箱截断残件应显式报错退出')
  rmSync(root, { recursive: true, force: true })
})
