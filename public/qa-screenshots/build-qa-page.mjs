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

// —— T4 多板切换器静态 QA 页（spec 视觉 §9 / UX §12；markup 类名与 lib/client.js 渲染一致，mock 数据）——
// 多板 mock：mtime 新→旧，一块 fromChat、一块上次使用（缓存命中）。
const BOARDS = [
  { file: 'mbs-t4.json', label: 'mbs-t4', mtime: '14:32', chat: true },
  { file: 'taskboard.json', label: 'taskboard', mtime: '13:05' },
  { file: 'archive.json', label: 'archive', mtime: '昨天' },
]

function boardPickerCards(lastUsedFile) {
  return `<div class="eso-tb-board-cards" role="listbox" aria-label="选择任务板">
${BOARDS.map((b) => {
    const isLast = b.file === lastUsedFile
    return `<button type="button" class="eso-tb-board-card" role="option" aria-selected="${isLast}"${isLast ? ' data-lastused=""' : ''} tabindex="${isLast ? 0 : -1}" title="${b.file}">
  <span class="eso-tb-board-card-name">${b.label}</span>
  <span class="eso-tb-board-card-meta">${isLast ? '<span>上次使用</span>' : ''}${b.chat ? '<span data-chat="">来自聊天链接</span>' : ''}<time>${b.mtime}</time></span>
</button>`
  }).join('\n')}
</div>`
}

// 密度自适应：镜像 lib/client.js ResizeObserver 断点（≥720 宽 / 480-719 标准 / 300-479 紧凑 / <300 兜底 / <360 裁剪档）
const DENSITY_SCRIPT = '<scr' + 'ipt>(function(){var el=document.querySelector(".eso-tb-root");function fit(){var w=el.clientWidth;'
  + 'if(w>=720)el.setAttribute("data-eso-tb-wide","");else el.removeAttribute("data-eso-tb-wide");'
  + 'if(w<360)el.setAttribute("data-eso-tb-w360","");else el.removeAttribute("data-eso-tb-w360");'
  + 'if(w>=300&&w<480)el.setAttribute("data-eso-tb-compact","");else el.removeAttribute("data-eso-tb-compact");'
  + 'if(w<300)el.setAttribute("data-eso-tb-xnarrow","");else el.removeAttribute("data-eso-tb-xnarrow");}'
  + 'fit();window.addEventListener("resize",fit);})()</scr' + 'ipt>'

// S2 选择板页（ambiguous ≥3 候选 + roving 焦点落在上次使用板，spec §9.1 / §12.2）
const pickerHtml = page('', '任务板 QA 多板选择页', `
<div class="eso-tb-board"><div class="eso-tb-picker">
  ${I.board}
  <span class="eso-tb-empty-title">检测到多个任务板</span>
  <span class="eso-tb-empty-body">请选择要打开的任务板（永不自动猜板）</span>
  ${boardPickerCards('taskboard.json')}
  <button type="button" class="eso-tb-linklike">重新检测</button>
</div></div>
<script>document.querySelector('[data-lastused]').focus()</script>${DENSITY_SCRIPT}`)

function boardSwitchTrigger(open, name) {
  return `<button type="button" class="eso-tb-board-switch" aria-haspopup="listbox" aria-expanded="${open}" aria-label="切换任务板" title="${name}.json">
  <span class="eso-tb-board-switch-name">${name}</span>${I.chevron}
</button>`
}

// S4 工具条下拉展开态（当前板 aria-selected 高亮 + 键盘 data-active 悬停近似，spec §9.2 / §12.3）
const dropdownHtml = withSwitch(page('data-eso-tb-wide=""', '任务板 QA 多板下拉', `
<div class="eso-tb-lanes">
${lane('attention', '需要注意', '1', card('T8', '多板下拉展开态（当前板高亮 + 左缘实条）', 'failed', { owner: '测试工程师', chips: ['lib/client.js'] }))}
${lane('done', '已完成', '2', card('T2', '纯函数层', 'done') + card('T3', 'UI 接线', 'done'))}
</div>`), { switchName: 'mbs-t4', menu: true })

// 切换后看板（选定板高亮见下拉页；本页展示切板完成态 + aria-live 播报，spec §12.5/F5）
const switchedHtml = withSwitch(page('data-eso-tb-wide=""', '任务板 QA 多板切换后', `
<div class="eso-tb-lanes">
${lane('running', '进行中', '1', card('T4', '测试与真机冒烟（切换后看板：现场恢复 + 焦点回切换按钮）', 'running', { owner: '测试工程师', chips: ['test/'] }))}
${lane('done', '已完成', '3', card('T1', 'spec 消化', 'done') + card('T2', '纯函数层', 'done') + card('T3', 'UI 接线', 'done'))}
</div>`), { switchName: 'mbs-t4' })

// S5 选定板消失内联条（旧渲染保留 + 重新检测，spec §12.1 / A33）
const s5Html = withSwitch(page('data-eso-tb-wide=""', '任务板 QA 多板 S5 内联条', `
<div class="eso-tb-errorstrip" data-kind="missing"><i></i><span>当前任务板已不在目录</span><button type="button" class="eso-tb-reset">重新检测</button></div>
<div class="eso-tb-lanes">
${lane('done', '已完成', '2', card('T2', '纯函数层（旧渲染保留，不自动换板）', 'done') + card('T3', 'UI 接线', 'done'))}
</div>`), { switchName: 'deleted-board' })

// withSwitch：在既有 page() 产物上注入 board-switch 触发钮（menu=true 时带展开面板）与 aria-live 播报
function withSwitch(html, opts = {}) {
  const trigger = boardSwitchTrigger(!!opts.menu, opts.switchName)
  let injection = trigger
  if (opts.menu) {
    injection += `<div class="eso-tb-board-menu" role="listbox" aria-label="切换任务板" aria-activedescendant="eso-tb-board-option-0">
${BOARDS.map((b, i) => {
      const selected = b.file === opts.switchName + '.json'
      return `<div class="eso-tb-board-option" id="eso-tb-board-option-${i}" role="option" aria-selected="${selected}"${i === 0 && !selected ? ' data-active=""' : ''}>
  <span class="eso-tb-board-option-name">${b.label}</span><span class="eso-tb-board-option-time">${b.mtime}</span>
</div>`
    }).join('\n')}
</div>`
  }
  html = html.replace('<span class="eso-tb-rev">', injection + '<span class="eso-tb-rev">')
  return html.replace('</body>', '<div class="eso-tb-live" role="status">已切换到 ' + opts.switchName + '</div>' + DENSITY_SCRIPT + '</body>')
}

mkdirSync(import.meta.dirname, { recursive: true })
writeFileSync(join(import.meta.dirname, 'qa-board-wide.html'), wideHtml)
writeFileSync(join(import.meta.dirname, 'qa-board-compact.html'), compactHtml)
writeFileSync(join(import.meta.dirname, 'qa-board-xnarrow.html'), xnarrowHtml)
writeFileSync(join(import.meta.dirname, 'qa-multi-board-picker.html'), pickerHtml)
writeFileSync(join(import.meta.dirname, 'qa-multi-board-dropdown.html'), dropdownHtml)
writeFileSync(join(import.meta.dirname, 'qa-multi-board-switched.html'), switchedHtml)
writeFileSync(join(import.meta.dirname, 'qa-multi-board-s5.html'), s5Html)
console.log('QA pages written:', ['qa-board-wide.html', 'qa-board-compact.html', 'qa-board-xnarrow.html',
  'qa-multi-board-picker.html', 'qa-multi-board-dropdown.html', 'qa-multi-board-switched.html', 'qa-multi-board-s5.html'].join(', '))
