#!/usr/bin/env node
// ⑤小切口 路由实测数据回填——样本聚合报告面（只读）。
//
// 读会话 cwd（或 --dir 指定目录）下 .expert-routing/samples.jsonl（lib/route-telemetry.js
// 在 summon 边界落盘的实测样本），按专家/模型聚合实测面并给出估算校准的反推比
// （tokPerChar）。零依赖 node，纯只读：不写任何文件、不改任何状态。
//
// 用法：node scripts/routing-metrics.mjs [--dir <cwd>] [--json] [--expert <名>] [--model <id>]
// - --json：机器面（与 aggregate() 输出一致，供后续校准脚本消费）；
// - --expert/--model：过滤单一维度。
// 校准口径（诚实边界）：tokPerChar = estTokens/(taskChars+answerChars)，是字符启发式
// 系数（CJK 0.75/other 0.25，lib/cost.js）的实测反推锚点——usage 键当前恒 null（宿主
// seam 未暴露真实 token），样本行形状已预留，usage 接入后本报告同槽位换实测值。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { aggregate } from '../lib/route-telemetry.js'

const args = process.argv.slice(2)
const argOf = (flag) => {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined
}
const dir = argOf('--dir') ?? process.cwd()
const jsonOut = args.includes('--json')
const expertFilter = argOf('--expert')
const modelFilter = argOf('--model')

const file = join(dir, '.expert-routing', 'samples.jsonl')
let rows = []
try {
  const raw = readFileSync(file, 'utf-8')
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try { rows.push(JSON.parse(s)) } catch { /* 残行跳过（聚合面只读不修，如实计数） */ rows.bad = (rows.bad ?? 0) + 1 }
  }
} catch {
  console.error(`无样本文件：${file}（路由遥测默认开启，summon 过即积累；DSH_EXPERT_ROUTE_TELEMETRY='0' 关闭）`)
  process.exit(0)
}
if (rows.bad) console.error(`跳过不可解析行 ${rows.bad} 条（残行如实计数，不静默）`)
if (expertFilter) rows = rows.filter((r) => r.expert === expertFilter)
if (modelFilter) rows = rows.filter((r) => r.model === modelFilter)

const agg = aggregate(rows)
if (jsonOut) {
  process.stdout.write(JSON.stringify({ file, filtered: Boolean(expertFilter || modelFilter), ...agg }, null, 2) + '\n')
  process.exit(0)
}

const fmtRow = (r) => {
  const reasons = Object.entries(r.stopReasons).map(([k, v]) => `${k}=${v}`).join('/') || '-'
  const dur = r.durationP50 != null ? `p50=${r.durationP50}ms p95=${r.durationP95}ms` : 'p50=-'
  return `${r.key}  调用=${r.count}(ok=${r.ok} fail=${r.fail} rate=${r.okRate})  estTok=${r.estTokens}  均回包=${r.avgAnswerChars}字  tok/字=${r.tokPerChar}  ${dur}  ${reasons}`
}
console.log(`路由遥测聚合：${file}`)
console.log(`样本 ${agg.samples} 条`)
const section = (title, rows2) => {
  console.log(`\n── ${title}（按调用数降序）──`)
  if (!rows2.length) console.log('（无数据）')
  for (const r of rows2) console.log(fmtRow(r))
}
section('按专家', agg.byExpert)
section('按模型', agg.byModel)
console.log('\n校准锚点：tok/字 = estTokens/(taskChars+answerChars)，估算系数（lib/cost.js CJK 0.75 / other 0.25）的实测反推比；')
console.log('usage 接入后同槽位换真实 token（lib/cost.js 头注预留的消费缝）。')
