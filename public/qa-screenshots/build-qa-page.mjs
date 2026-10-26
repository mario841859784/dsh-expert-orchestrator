// build-qa-page.mjs — QA 静态测试页生成器（零依赖，仅 QA 脚手架，非产品代码）。
// 从 ../../lib/client.js 实时提取 TB_CSS（与交付代码单一真相），生成含代表性任务板
// DOM 的自包含 HTML，供 Playwright 截图宽/窄两模式。页面内 token 兜底值为近似色，
// 仅用于无宿主主题环境下的结构渲染冒烟，不代表真机配色。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

// 提取 `var NAME = [ ... ];` 数组字面量（字符串感知的括号/方括号扫描）
function extractArray(name) {
  const start = source.indexOf(`var ${name} = [`)
  if (start < 0) throw new Error(`marker not found: var ${name} = [`)
  let i = source.indexOf('[', start)
  let depth = 0
  let inStr = false
  for (; i < source.length; i++) {
    const ch = source[i]
    if (inStr) {
      if (ch === '\\') { i++; continue }
      if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '[') depth++
    else if (ch === ']') { depth--; if (depth === 0) break }
  }
  const literal = source.slice(source.indexOf('[', start), i + 1)
  return new Function(`return ${literal};`)().join('')
}

const tbCss = extractArray('TB_CSS')

// QA 兜底 token（近似宿主亮色主题；仅脚手架用）
const tokens = `
:root{
  --dsw-radius-xs:4px;--dsw-radius-sm:6px;--dsw-radius-md:8px;--dsw-radius-lg:12px;
  --dsw-alias-bg-base:#f7f8fa;--dsw-alias-bg-layer-1:#ffffff;--dsw-alias-bg-layer-2:#ffffff;--dsw-alias-bg-layer-3:#f2f3f5;
  --dsw-alias-bg-module-platform:#eef0f4;--dsw-alias-bg-skeleton:rgba(0,0,0,.05);
  --dsw-alias-border-l1:rgba(0,0,0,.06);--dsw-alias-border-l2:rgba(0,0,0,.12);
  --dsw-alias-brand-primary:#14161a;--dsw-alias-label-primary:#14161a;--dsw-alias-label-secondary:#5c6068;
  --dsw-alias-label-tertiary:#9aa0aa;--dsw-alias-link:#2f6fe4;
  --dsw-alias-fill-l1:rgba(0,0,0,.04);--dsw-alias-fill-l2:rgba(0,0,0,.08);
  --dsw-alias-interactive-bg-hover:rgba(0,0,0,.05);--dsw-alias-interactive-bg-hover-accent:rgba(47,111,228,.08);
  --dsw-alias-state-business-primary:#2f6fe4;--dsw-alias-state-success-primary:#22a06b;
  --dsw-alias-state-success-tertiary:#e3f6ec;--dsw-alias-state-error-primary:#d64545;
  --dsw-alias-state-error-secondary:#f0a3a3;--dsw-alias-state-warn-primary:#d9930d;
  --dsw-alias-state-warn-tertiary:#fbf0da;--dsw-alias-state-warn-label:#8a6116;
  --dsw-alias-state-idle-primary:#9aa0aa;--dsw-alias-label-primary-inverted:#ffffff;
}
body{margin:0;background:var(--dsw-alias-bg-base);font-family:system-ui,sans-serif;}
`

const svg = (p, s = 12) =>
  `<svg width="${s}" height="${s}" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="${p}"/></svg>`
const I = {
  board: svg('M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z'),
  chevron: svg('M4.5 6 8 9.5 11.5 6', 12),
  warn: svg('M8 1 15 14H1zM7 6h2v4H7zM7 11h2v2H7z'),
  refresh: svg('M8 3a5 5 0 1 0 5 5h-1.5A3.5 3.5 0 1 1 8 4.5V7l3.5-3L8 1z'),
  filter: svg('M2 3h12L9.5 8.5V14l-3-1.5V8.5z'),
  file: svg('M4 1h6l3 3v11H4zM10 1v3h3'),
  check: svg('M6.5 11.9 3.2 8.6l1.06-1.06L6.5 9.78l5.24-5.24L12.8 5.6z', 14),
}

function card(id, title, status, opts = {}) {
  const dot = `<span class="eso-tb-statusdot" data-st="${status}"></span>`
  const blocked = opts.blocked
    ? `<span class="eso-tb-badge-blocked" title="${opts.blocked}">${I.warn}阻塞 ×1</span>`
    : ''
  if (opts.compact) {
    // 紧凑档两行卡（React renderCard compact 分支结构）：行1 点+ID+标题+阻塞徽章+chevron；行2 owner+scope 计数
    return `<div class="eso-tb-card" data-status="${status}">
  <button type="button" class="eso-tb-card-head" aria-expanded="false">${dot}<span class="eso-tb-card-id">${id}</span><span class="eso-tb-card-title">${title}</span>${blocked}<span class="eso-tb-chevron">${I.chevron}</span></button>
  <div class="eso-tb-card-meta2">${opts.owner ? `<span class="eso-tb-card-owner">${opts.owner}</span>` : ''}${opts.scopeCount ? `<span class="eso-tb-card-scopecount">${opts.scopeCount}</span>` : ''}</div>
</div>`
  }
  return `<div class="eso-tb-card" data-status="${status}">
  <button type="button" class="eso-tb-card-head" aria-expanded="false">${dot}<span class="eso-tb-card-title">${title}</span>${blocked}<span class="eso-tb-chevron">${I.chevron}</span></button>
  <div class="eso-tb-card-meta"><span class="eso-tb-card-id">${id}</span>${opts.owner ? `<span class="eso-tb-card-owner">${opts.owner}</span>` : ''}</div>
  ${opts.chips ? `<div class="eso-tb-card-badges">${opts.chips.map((c) => `<span class="eso-tb-chip">${I.file}<span>${c}</span></span>`).join('')}</div>` : ''}
</div>`
}

function lane(name, label, countLabel, cards, opts = {}) {
  const fold = opts.fold ? `<button type="button" class="eso-tb-lane-fold" aria-expanded="true" title="折叠">${I.chevron}</button>` : ''
  const body = cards
    ? `<div class="eso-tb-lane-cards${opts.twoCol ? ' eso-tb-lane-cards-wide' : ''}">${cards}</div>`
    : `<div class="eso-tb-lane-empty">无任务</div>`
  return `<section class="eso-tb-lane" data-lane="${name}">
  <div class="eso-tb-lane-head"><span class="eso-tb-lane-dot" data-lane="${name}"></span><span class="eso-tb-lane-name">${label}</span><span class="eso-tb-lane-count">${countLabel}</span>${fold}</div>
  ${body}
</section>`
}

function page(densityAttrs, title, boardHtml) {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>${tokens}</style><style>${tbCss}</style></head>
<body><div class="eso-tb-root" ${densityAttrs}>
<div class="eso-tb-toolbar">
  <span class="eso-tb-title">${I.board} 任务板</span><span class="eso-tb-rev">r42</span>
  <span class="eso-tb-watch"><span class="eso-tb-count-dot" data-st="done"></span>3</span>
  <span class="eso-tb-toolbar-spacer"></span>
  <label class="eso-tb-switch"><input type="checkbox" checked><span></span></label>
  <button type="button" class="eso-tb-iconbtn">${I.refresh}</button>
  <button type="button" class="eso-tb-iconbtn" data-eso-tb-filter="" data-active="">${I.filter}</button>
</div>
<div class="eso-tb-summary">
  <span class="eso-tb-progress"><span style="width:38%"></span></span>
  <span class="eso-tb-count"><span class="eso-tb-count-dot" data-st="done"></span>3</span>
  <span class="eso-tb-count"><span class="eso-tb-count-dot" data-st="running"></span>1</span>
  <span class="eso-tb-count"><span class="eso-tb-count-dot" data-st="escalated"></span>2</span>
</div>
${boardHtml}
</div></body></html>`
}

const wideHtml = page('data-eso-tb-wide=""', '任务板 QA 宽档', `
<div class="eso-tb-complete" role="status">
  ${I.check}<span class="eso-tb-complete-title">全部完成</span>
  <span class="eso-tb-complete-count">3/8 已完成</span><time class="eso-tb-complete-ago">2 分钟前</time>
</div>
<div class="eso-tb-lanes">
${lane('attention', '需要注意', '2',
  card('T8', '样式注入修复', 'failed', { owner: '前端开发者', chips: ['lib/client.js'] }) +
  card('T9', '真机冒烟协调', 'escalated', { owner: 'coordinator' }))}
${lane('running', '进行中', '0', null)}
${lane('todo', '待处理', '2/3',
  card('T5', '准备验收材料', 'ready', { owner: 'PM', blocked: '等待 T3' }) +
  card('T6', '归档规格文档', 'draft', { owner: 'PM' }))}
${lane('done', '已完成', '4',
  card('T1', 'spec 消化', 'done') + card('T2', '基线核实', 'done') + card('T4', 'token 清理', 'done') + card('T7', '测试补齐', 'done'),
  { fold: true })}
</div>`)

// 紧凑档（300-479）：两行卡
const compactHtml = page('data-eso-tb-compact=""', '任务板 QA 紧凑档', `
<div class="eso-tb-lanes">
${lane('attention', '需要注意', '1', card('T8', '样式注入修复', 'failed', { compact: true, owner: '前端开发者', scopeCount: '1 个文件' }))}
${lane('running', '进行中', '1', card('T3', '任务板呈现层重写（紧凑档两行卡：行1 点+ID+标题+阻塞徽章）', 'running', { compact: true, blocked: 'x', owner: '前端开发者', scopeCount: '3 个文件' }))}
${lane('todo', '待处理', '0', null)}
${lane('done', '已完成', '3', card('T1', 'spec 消化', 'done', { compact: true }) + card('T2', '基线核实', 'done', { compact: true }) + card('T4', 'token 清理', 'done', { compact: true }), { fold: true })}
</div>`)

// <300 兜底档（真实组件同时设 w360：隐藏 rev/watch）
const xnarrowHtml = page('data-eso-tb-xnarrow="" data-eso-tb-w360=""', '任务板 QA 兜底档', `
<div class="eso-tb-lanes">
${lane('attention', '需要注意', '1', card('T8', '样式注入修复（兜底档标题单行、隐藏 scope chips 仅留阻塞徽标）', 'failed'))}
${lane('todo', '待处理', '1', card('T5', '准备验收材料', 'ready'))}
${lane('done', '已完成', '2', card('T1', 'spec 消化', 'done') + card('T2', '基线核实', 'done'))}
</div>`)

mkdirSync(import.meta.dirname, { recursive: true })
writeFileSync(join(import.meta.dirname, 'qa-board-wide.html'), wideHtml)
writeFileSync(join(import.meta.dirname, 'qa-board-compact.html'), compactHtml)
writeFileSync(join(import.meta.dirname, 'qa-board-xnarrow.html'), xnarrowHtml)
console.log('QA pages written:', ['qa-board-wide.html', 'qa-board-compact.html', 'qa-board-xnarrow.html'].join(', '))
