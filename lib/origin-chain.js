// #21 origin chain 递归防护（v2.8 M8-2 / WP-7 ③，T26）
//
// 参考实现：dsh-crew src/origin-guard.mjs（调研 C-expert-team-swarm §3 ③；借鉴结论见
// expert-team-research/C-expert-team-swarm.md 第 7 条）。与 crew 的差异（宿主能力面实测
// 后的诚实适配，2026-10-09）：
// - crew 经跨进程 env（DSH_CREW_ORIGIN_CHAIN）传链；本插件的派生主通道是进程内 summon
//   （lib/tools.js runExpert），宿主 SubagentStartRequest/ContinuableStartSpec **没有 env
//   字段**（dsh-subagent 0.2.1 types 实测）——因此链的传递通道改为**任务书尾部标记行**
//   （单行 HTML 注释内嵌 JSON，沿 `<!-- methods-cut -->` / `<!-- tools: … -->` 标记先例），
//   协议侧约定见 SKILL.md §5「委派任务书模板」env 传递段与 §3 递归防护段。
// - 语义逐条对齐 WP-7 ③ 原文：链上每跳记 (专家名, cwd)；链上重复对拒绝；**深度由链长
//   推导**（不信任任何计数字段——crew 教训：env 可被敌意注入，深度一律由链长推导）。
// - deny 列表（toolFilter，lib/tools.js EXPERT_TOOLS_DENY_LIST）仍是主防线；origin chain
//   是跨面兜底：覆盖 deny 失效（宿主注册面差异/未来通道变化）与子代理经 subagent 回退
//   通道再委派的「白纸召唤自吞噬」场景。
//
// 边界（如实声明）：子代理改写/剥除标记行即可规避本链（与「能写工作区文件者可直改主板」
// 同信任级别，协议 §9 非目标）；标记行解析失败按无链处理（fail-open + stderr 告警）——
// 对有动机的规避者严格化解析不增加安全性（整行省略与坏行等价），只误伤正常复制的任务书。
// 主防线与兜底的分工见 SKILL.md §3。
import { realpathSync } from 'node:fs'

/** 排障开关（沿 DSH_EXPERT_AUTOCLAIM/RESUME/PROFILES 惯例）：'0' 或空串整体关闭
 *  origin chain（不解析、不追加、不拒绝——任务书逐字节回到既有行为）。 */
export function originChainEnabled(env = process.env) {
  const flag = env.DSH_EXPERT_ORIGIN_CHAIN
  return !(flag === '0' || flag === '')
}

/** 标记行形态（单行）：<!-- origin-chain: [{"n":"专家名","c":"/abs/cwd"},…] -->
 *  JSON 承载名字与路径（两者都可能含 @、空格、中文、'→' 等字符，平文本分隔符必撞）；
 *  正则内禁换行，保证标记行永远是单行（任务书尾部追加、逐字复制约定都依赖单行形态）。
 *  剥除形态连带吞掉行首连接换行：标记行移除后不留空行残骸。 */
const ORIGIN_CHAIN_MARK_RE = /\n?[ \t]*<!--\s*origin-chain:\s*(\[[^\n]*?\])\s*-->[ \t]*/g

/** cwd 归一：realpath 消除符号链接别名（crew 教训：macOS /tmp→/private/tmp 之类别名
 *  会让同一工作区以两个 cwd 形态入链、绕过重复对检测）；realpath 失败（目录尚未创建
 *  等）回退原值。每跳调用一次（summon 频度下一次 syscall 可忽略）。 */
export function normalizeCwdAnchor(cwd) {
  try {
    return realpathSync(cwd)
  } catch {
    return cwd
  }
}

/** 从任务文本解析 origin chain（取**最后一个**合法标记——链逐跳延伸，最后者最权威）；
 *  同时返回剥除全部标记行后的净文本（出站任务书只追加一个新标记，不堆积历史标记行）。
 *  无标记 → { chain: [], text: 原样逐字节返回 }（既有任务书零扰动）；存在标记但 JSON
 *  非法/条目形状非法 → console.warn 后按无链处理（fail-open，见文件头边界声明），标记行
 *  仍然剥除（防止坏标记行随出站任务书继续漂流）。导出供自测。 */
export function parseOriginChain(text, { warn = (m) => console.warn(`[dsh-expert-orchestrator] ${m}`) } = {}) {
  const raw = typeof text === 'string' ? text : ''
  const matches = [...raw.matchAll(ORIGIN_CHAIN_MARK_RE)]
  if (matches.length === 0) return { chain: [], text: raw }
  const stripped = raw.replace(ORIGIN_CHAIN_MARK_RE, '').trimEnd()
  let chain = []
  const last = matches[matches.length - 1][1]
  try {
    const parsed = JSON.parse(last)
    if (!Array.isArray(parsed)) throw new Error('not an array')
    chain = parsed.map((hop) => {
      if (!hop || typeof hop !== 'object' || Array.isArray(hop)) throw new Error('hop not an object')
      if (typeof hop.n !== 'string' || !hop.n || typeof hop.c !== 'string' || !hop.c) throw new Error('hop missing n/c string')
      return { n: hop.n, c: hop.c }
    })
  } catch (error) {
    warn(`origin chain 标记行解析失败（按无链处理，fail-open）：${error?.message ?? error}`)
    chain = []
  }
  return { chain, text: stripped }
}

/** 链上重复对检测 + 延伸（WP-7 ③：链上重复对拒绝）。hop={n,c}；返回 {ok:false, cycle}
 *  （cycle=重复的那一跳，调用方构造含整链的拒绝错误）或 {ok:true, chain}（延伸后的新链）。 */
export function extendOriginChain(chain, hop) {
  const dup = (chain ?? []).find((h) => h.n === hop.n && h.c === hop.c)
  if (dup) return { ok: false, cycle: dup }
  return { ok: true, chain: [...(chain ?? []), { n: hop.n, c: hop.c }] }
}

/** 深度由链长推导（WP-7 ③ 原文）——不维护、不信任任何独立计数字段。 */
export function originChainDepth(chain) {
  return (chain ?? []).length
}

/** 链的渲染（拒绝错误信息内必须含链路本身——验收 (c) 原文）：A@/cwd1 → B@/cwd2。 */
export function renderOriginChain(chain) {
  return (chain ?? []).map((h) => `${h.n}@${h.c}`).join(' → ')
}

/** 出站标记行（单行 JSON；JSON.stringify 保 Unicode 原样，中文名零转义噪音）。 */
export function renderOriginChainMarker(chain) {
  return `<!-- origin-chain: ${JSON.stringify(chain)} -->`
}

/** summon 派发入口的一次性判定（lib/tools.js runExpert 调用）：入站任务书解析 →
 *  (专家名, cwd) 重复对检测 → 延伸。返回 { ok:false, message }（拒绝；message 含整链）
 *  或 { ok:true, taskText, chain }（出站任务书=剥旧标记的净文本，由调用方追加经验提示
 *  后再尾加新标记行——顺序约定：经验提示在前、链标记行收尾，保证「任务书最后一行」
 *  恒为标记行，供 §5 探针与子代理逐字复制）。 */
export function checkOriginChain({ taskText, expertName, cwd, warn } = {}) {
  const anchor = normalizeCwdAnchor(cwd)
  const { chain, text } = parseOriginChain(taskText, { warn })
  const r = extendOriginChain(chain, { n: expertName, c: anchor })
  if (!r.ok) {
    const next = [...chain, r.cycle]
    return {
      ok: false,
      message:
        `委派链环路拒绝（origin chain 检测到链上重复对 ${r.cycle.n}@${r.cycle.c}）：` +
        `${renderOriginChain(next)} —— 链上禁止循环委派（深度由链长推导：${originChainDepth(next)}）。` +
        '若确需重启同名专家，请由编排者在新发起的委派中重开任务书（不携带 origin chain 标记行），不得在既有链内循环转发。',
    }
  }
  return { ok: true, taskText: text, chain: r.chain }
}
