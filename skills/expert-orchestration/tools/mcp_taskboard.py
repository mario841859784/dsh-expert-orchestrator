#!/usr/bin/env python3
# 方向 5 协议对接（dev/orchestration-economics-345）：任务板/花名册的 MCP stdio 导出面。
#
# 依据 docs/research/protocol-interop-mcp-a2a/00-protocol-interop.md（MCP stdio transport
# = JSON-RPC 2.0 newline-delimited over stdin/stdout；tools/list + tools/call 最小面）。
# 定位：把 taskboard.py 的板面操作与合并花名册以 MCP 工具形态导出，让外部代理/宿主
#（非 dsh 宿主）能作为「可互操作节点」读写板面——零依赖（纯 python3，无 SDK）。
#
# 安全与信任边界（如实声明，方向 4 语义的延续）：
# - **读面默认开放、写面默认关闭**：DSH_TASKBOARD_MCP_WRITES 非空时才暴露 create/claim/
#   progress/done/fail 写工具（缺省 tools/list 不列出、tools/call 具名拒 writes_disabled）
#   ——外部代理的写入按方向 4 口径=代理转达的板面变更，审计落 CLI 既有事件流（自报）。
# - **stdio = 与 CLI 同信任级别**：能启动本进程的调用方本就能直跑 taskboard.py——本服务
#   不新增执法面（CLI 无鉴权，防误用不防伪造），只做协议转换与写面开关。
# - 身份自报：调用方身份经工具参数（owner/--by 类参数）与 initialize 的 clientInfo 留痕，
#   板面「自报，防误用不防伪造」口径不变。
# - **写面审计回显（N2，exposure-crypto-trust 报告 §5.2）**：写工具成功响应尾行附【审计】
#   回显行——task/status/owner/by/event_seq/revision，全部取自 taskboard.py --json 信封
#   （event_seq=本次落账后事件流末 seq，写命令信封对账锚点；by=调用参数自报）。把「代理
#   转达变更」的审计口径变成可机读对账面：外部调用方（如 hermes）能看到自己写的任务被
#   怎么处置，并可持 event_seq 对事件流对账。不做边界：不为 stdio 添加伪鉴权（env 即边界的
#   口径不变），拒绝面（isError）不附审计行（零写零事件，拒绝本身就是处置）。
# - 单向导出：summon/编排工具**不导出**（递归防护 deny 清单语义的镜像——外部节点拿到的
#   是板面 CRUD 与花名册只读视图，不是「再召唤专家」的入口）。
import json
import os
import subprocess
import sys

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
TASKBOARD = os.path.join(TOOLS_DIR, 'taskboard.py')
# 技能目录根（花名册/内置专家解析锚点）：DSH_TASKBOARD_MCP_SKILL_DIR 可指向其他部署副本
# （自测/对账注入），缺省=本脚本所在技能目录——与 --board 注入同一「测试可控、部署零配置」口径。
SKILL_DIR = os.environ.get('DSH_TASKBOARD_MCP_SKILL_DIR', '').strip() or os.path.dirname(TOOLS_DIR)
ROSTER = os.path.join(SKILL_DIR, 'expert-sources', 'merged', 'roster.json')
EXPERTS_DIR = os.path.join(SKILL_DIR, 'experts')

PROTOCOL_VERSION = '2025-06-18'
SERVER_INFO = {'name': 'dsh-taskboard-mcp', 'version': '0.1.0'}

# ── 工具登记表 ────────────────────────────────────────────────────────────────
# inputSchema 为 JSON Schema（draft-07 子集，MCP tools/inputSchema 既有惯例）。
READ_TOOLS = [
    {
        'name': 'taskboard_status',
        'description': '任务板总览：各状态任务计数、待批准草案、已升级待用户处置行（taskboard.py status）。',
        'inputSchema': {'type': 'object', 'properties': {}},
    },
    {
        'name': 'taskboard_list',
        'description': '任务清单（taskboard.py list）。',
        'inputSchema': {'type': 'object', 'properties': {}},
    },
    {
        'name': 'taskboard_show',
        'description': '任务详情：标题/状态/owner/依赖/检查点/验收（taskboard.py show <id>）。写前先读。',
        'inputSchema': {'type': 'object', 'properties': {'id': {'type': 'string', 'description': '任务 id（如 T3）'}}, 'required': ['id']},
    },
    {
        'name': 'taskboard_deps',
        'description': '任务依赖关系（taskboard.py deps <id>）。',
        'inputSchema': {'type': 'object', 'properties': {'id': {'type': 'string'}}, 'required': ['id']},
    },
    {
        'name': 'taskboard_open_counts',
        'description': '按 owner 聚合 open 任务数（draft/pending/ready/running；taskboard.py open-counts，反风暴核查面）。',
        'inputSchema': {'type': 'object', 'properties': {'owner': {'type': 'string', 'description': '只统计该 owner；缺省聚合全部'}}},
    },
    {
        'name': 'taskboard_budget',
        'description': '工具调用硬预算盘点（taskboard.py budget <id> --json 信封 data.budget）。',
        'inputSchema': {'type': 'object', 'properties': {'id': {'type': 'string'}}, 'required': ['id']},
    },
    {
        'name': 'list_experts',
        'description': '专家花名册只读视图：合并花名册（bundled-core + 已启用来源；来源标注、disabled/shadowed 标注）或 bundled-core 兜底（expert-sources 未部署时）。',
        'inputSchema': {'type': 'object', 'properties': {}},
    },
]

WRITE_TOOLS = [
    {
        'name': 'taskboard_create',
        'description': '创建任务（taskboard.py create；外部代理写面）。scope 声明关联域（门禁第三查依据）。',
        'inputSchema': {'type': 'object', 'properties': {
            'title': {'type': 'string'}, 'owner': {'type': 'string'}, 'desc': {'type': 'string'},
            'scope': {'type': 'string'}, 'draft': {'type': 'boolean', 'description': '创建为 PM 草案（draft 待批）'},
        }, 'required': ['title']},
    },
    {
        'name': 'taskboard_claim',
        'description': '认领任务（taskboard.py claim <id> <owner>；ready→running，owner 自报）。',
        'inputSchema': {'type': 'object', 'properties': {'id': {'type': 'string'}, 'owner': {'type': 'string'}}, 'required': ['id', 'owner']},
    },
    {
        'name': 'taskboard_progress',
        'description': '落检查点（taskboard.py progress <id> <note>；长任务每阶段必落）。',
        'inputSchema': {'type': 'object', 'properties': {'id': {'type': 'string'}, 'note': {'type': 'string'}}, 'required': ['id', 'note']},
    },
    {
        'name': 'taskboard_done',
        'description': '完成任务（taskboard.py done <id> <summary>；依赖自动提升；--by 实际执行者自报）。',
        'inputSchema': {'type': 'object', 'properties': {'id': {'type': 'string'}, 'summary': {'type': 'string'}, 'by': {'type': 'string'}}, 'required': ['id']},
    },
    {
        'name': 'taskboard_fail',
        'description': '标记失败（taskboard.py fail <id> <reason>；连续失败循环升级执法开启时达限自动 escalated）。',
        'inputSchema': {'type': 'object', 'properties': {'id': {'type': 'string'}, 'reason': {'type': 'string'}}, 'required': ['id']},
    },
]


def writes_enabled():
    return bool(os.environ.get('DSH_TASKBOARD_MCP_WRITES', '').strip())


def all_tools():
    return READ_TOOLS + (WRITE_TOOLS if writes_enabled() else [])


# ── CLI 执行与花名册读取 ──────────────────────────────────────────────────────

def run_taskboard(args):
    cmd = [sys.executable, TASKBOARD]
    board = os.environ.get('DSH_TASKBOARD_MCP_BOARD', '').strip()
    if board:
        cmd += ['--board', board]
    cmd += args
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return {'code': r.returncode, 'stdout': r.stdout, 'stderr': r.stderr}
    except subprocess.TimeoutExpired:
        return {'code': 124, 'stdout': '', 'stderr': 'taskboard.py 超时（30s）'}


def parse_receipt(stdout):
    """taskboard.py --json 信封解析：可解析则返回结构化对象，否则 None（回退人读文本）。"""
    try:
        v = json.loads(stdout.strip())
        return v if isinstance(v, dict) else None
    except (json.JSONDecodeError, ValueError):
        return None


def roster_fallback():
    """bundled-core 兜底：expert-sources 未部署（纯仓库/纯 CLI 形态）时扫描 experts/*.md
    frontmatter 的 name:/title: 行（与部署面花名册两套命名的事实一致，标注 fallback）。"""
    out = []
    if os.path.isdir(EXPERTS_DIR):
        for fn in sorted(os.listdir(EXPERTS_DIR)):
            if not fn.endswith('.md'):
                continue
            name = title = ''
            in_fm = False
            try:
                with open(os.path.join(EXPERTS_DIR, fn), 'r', encoding='utf-8') as f:
                    for i, line in enumerate(f):
                        if i == 0 and line.strip() == '---':
                            in_fm = True
                            continue
                        if in_fm and line.strip() == '---':
                            break
                        if in_fm and line.startswith('name:') and not name:
                            name = line.split(':', 1)[1].strip()
                        elif in_fm and line.startswith('title:') and not title:
                            title = line.split(':', 1)[1].strip()
            except OSError:
                continue
            out.append({'source': 'bundled-core', 'file': fn, 'name': name or title or fn[:-3], 'title': title})
    return out


def deployed_roster_experts():
    """deployed merged roster 解析：真实 schema 与 lib/tools.js rosterCandidates 逐字段
    同口径——{ core: [{source?,file,name?,title?,shadowed?,disabled?}...],
    sources: [{id, files: [...]}...] }（core 缺 source 补 bundled-core、files 缺 source
    补所属来源 id）。文件缺失/损坏/形状非法 → None（调用方回落 bundled 兜底）。"""
    if not os.path.isfile(ROSTER):
        return None
    try:
        with open(ROSTER, 'r', encoding='utf-8') as f:
            raw = json.load(f)
    except (json.JSONDecodeError, OSError):
        return None
    if not isinstance(raw, dict):
        return None
    out = []
    for e in raw.get('core') if isinstance(raw.get('core'), list) else []:
        if not isinstance(e, dict) or not isinstance(e.get('file'), str):
            continue
        out.append({'source': e.get('source') or 'bundled-core', 'name': e.get('name'), 'title': e.get('title'),
                    'disabled': bool(e.get('disabled')), 'shadowed': bool(e.get('shadowed'))})
    for s in raw.get('sources') if isinstance(raw.get('sources'), list) else []:
        if not isinstance(s, dict):
            continue
        for e in s.get('files') if isinstance(s.get('files'), list) else []:
            if not isinstance(e, dict) or not isinstance(e.get('file'), str):
                continue
            out.append({'source': e.get('source') or s.get('id') or 'unknown', 'name': e.get('name'), 'title': e.get('title'),
                        'disabled': bool(e.get('disabled')), 'shadowed': bool(e.get('shadowed'))})
    return out


def _fmt_expert_row(e):
    label = e.get('name') or e.get('title') or '（无名条目）'
    marks = ('（已停用）' if e.get('disabled') else '') + ('（shadowed）' if e.get('shadowed') else '')
    return f"- [{e.get('source', '?')}] {label}{marks}"


def list_experts_text():
    deployed = deployed_roster_experts()
    if deployed is not None:
        lines = [f'专家花名册（{len(deployed)} 位；deployed merged roster）：']
        lines.extend(_fmt_expert_row(e) for e in deployed)
        return '\n'.join(lines)
    if os.path.isfile(ROSTER):
        return f'merged roster 读取失败（{ROSTER} 损坏或形状非法），以下为 bundled-core 兜底：\n' + _fmt_fallback()
    return 'expert-sources/merged/roster.json 未部署（设置页完成来源下载后出现）。当前 bundled-core 兜底花名册：\n' + _fmt_fallback()


def _fmt_fallback():
    rows = roster_fallback()
    return '\n'.join(f"- [{r['source']}] {r['name']}" for r in rows) or '（experts/ 目录为空）'


# ── tools/call 实现 ───────────────────────────────────────────────────────────

def is_write_tool(name):
    return any(t['name'] == name for t in WRITE_TOOLS)


def audit_echo(name, args, receipt):
    """写面审计回显行（N2）：字段全部取自 --json 回执（信封顶层 event_seq/revision +
    data.task 快照）与调用参数（by=自报，与 --by 口径一致），一行组装；data.task 缺失
    （旧版 taskboard.py 回执或异常形态）返回 None——回显缺位不是错误，正文回执照常返回。"""
    if not isinstance(receipt, dict):
        return None
    t = receipt.get('data', {}).get('task')
    if not isinstance(t, dict):
        return None
    fields = [f'task={t.get("id", "?")}', f'status={t.get("status", "?")}']
    owner = t.get('owner') or ''
    if owner:
        fields.append(f'owner={owner}')
    by = (args.get('by') or args.get('owner') or '') if isinstance(args, dict) else ''
    if by:
        fields.append(f'by={by}')
    fields.append(f'event_seq={receipt.get("event_seq")}')
    fields.append(f'revision={receipt.get("revision")}')
    return '【审计】' + ' '.join(fields)


def call_tool(name, args):
    """返回 MCP content 数组。写面关闭时具名拒（isError=True + 指路 env）。
    结构化调用统一带 --json（全局旗标置于子命令前）——信封单行 JSON 可解析，
    错误面 {"ok":false,...} 亦结构化（外部消费方不依赖人读文本格式）。"""
    if is_write_tool(name) and not writes_enabled():
        return _err_text(f'writes_disabled: 写工具未启用——MCP 导出面缺省只读；'
                         f'确认要开放外部板面写入时以环境变量 DSH_TASKBOARD_MCP_WRITES=1 启动本服务（方向 4：外部写入=代理转达变更，审计走 CLI 事件流自报口径）')
    a = args if isinstance(args, dict) else {}
    if name == 'taskboard_status':
        r = run_taskboard(['status'])
    elif name == 'taskboard_list':
        r = run_taskboard(['--json', 'list'])
    elif name == 'taskboard_show':
        r = run_taskboard(['--json', 'show', str(a.get('id', ''))])
    elif name == 'taskboard_deps':
        r = run_taskboard(['--json', 'deps', str(a.get('id', ''))])
    elif name == 'taskboard_open_counts':
        argv = ['--json', 'open-counts']
        if a.get('owner'):
            argv.append(str(a['owner']))
        r = run_taskboard(argv)
    elif name == 'taskboard_budget':
        r = run_taskboard(['--json', 'budget', str(a.get('id', ''))])
    elif name == 'list_experts':
        return _ok_text(list_experts_text())
    elif name == 'taskboard_create':
        argv = ['--json', 'create', str(a.get('title', ''))]
        if a.get('owner'):
            argv += ['--owner', str(a['owner'])]
        if a.get('desc'):
            argv += ['--desc', str(a['desc'])]
        if a.get('scope'):
            argv += ['--scope', str(a['scope'])]
        if a.get('draft'):
            argv.append('--draft')
        r = run_taskboard(argv)
    elif name == 'taskboard_claim':
        r = run_taskboard(['--json', 'claim', str(a.get('id', '')), str(a.get('owner', ''))])
    elif name == 'taskboard_progress':
        r = run_taskboard(['--json', 'progress', str(a.get('id', '')), str(a.get('note', ''))])
    elif name == 'taskboard_done':
        argv = ['--json', 'done', str(a.get('id', ''))]
        if a.get('summary'):
            argv.append(str(a['summary']))
        if a.get('by'):
            argv += ['--by', str(a['by'])]
        r = run_taskboard(argv)
    elif name == 'taskboard_fail':
        argv = ['--json', 'fail', str(a.get('id', ''))]
        if a.get('reason'):
            argv.append(str(a['reason']))
        r = run_taskboard(argv)
    else:
        return _err_text(f'unknown_tool: {name}')
    if r['code'] != 0:
        # CLI 拒绝（--json 错误信封/人读 stderr）→ isError 内容回传，调用方按错误处置
        receipt = parse_receipt(r['stdout'])
        detail = json.dumps(receipt, ensure_ascii=False) if receipt else (r['stderr'] or r['stdout'])
        return _err_text(f'taskboard_exit_{r["code"]}: {detail.strip()}')
    receipt = parse_receipt(r['stdout'])
    if receipt is not None:
        text = json.dumps(receipt, ensure_ascii=False, indent=2)
        if is_write_tool(name):
            audit = audit_echo(name, a, receipt)  # N2：写面成功响应尾行附审计回显
            if audit:
                text += '\n' + audit
        return _ok_text(text)
    return _ok_text(r['stdout'].strip() or '（无输出）')


def _ok_text(text):
    return {'content': [{'type': 'text', 'text': text}], 'isError': False}


def _err_text(text):
    return {'content': [{'type': 'text', 'text': text}], 'isError': True}


# ── JSON-RPC 2.0 over stdio（MCP stdio transport：newline-delimited）──────────

def respond(id, result):
    _write({'jsonrpc': '2.0', 'id': id, 'result': result})


def respond_error(id, code, message):
    _write({'jsonrpc': '2.0', 'id': id, 'error': {'code': code, 'message': message}})


def _write(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def handle(msg):
    if not isinstance(msg, dict):
        return
    method = msg.get('method')
    id = msg.get('id')
    if method == 'initialize':
        requested = (msg.get('params') or {}).get('protocolVersion')
        respond(id, {
            'protocolVersion': requested if isinstance(requested, str) and requested else PROTOCOL_VERSION,
            'capabilities': {'tools': {}},
            'serverInfo': SERVER_INFO,
        })
        return
    if method == 'notifications/initialized' or (method and method.startswith('notifications/')):
        return  # 通知不回包
    if method == 'ping':
        respond(id, {})
        return
    if method == 'tools/list':
        respond(id, {'tools': all_tools()})
        return
    if method == 'tools/call':
        params = msg.get('params') or {}
        name = params.get('name')
        if not isinstance(name, str):
            respond_error(id, -32602, 'params.name 必填')
            return
        respond(id, call_tool(name, params.get('arguments')))
        return
    if id is not None:
        respond_error(id, -32601, f'method not found: {method}')


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue  # 非法行丢弃（stdio 半字节污染容错；有 id 的可解析面才可能回错）
        handle(msg)


if __name__ == '__main__':
    main()
