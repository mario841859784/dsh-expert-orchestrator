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
# - 单向导出：summon/编排工具**不导出**（递归防护 deny 清单语义的镜像——外部节点拿到的
#   是板面 CRUD 与花名册只读视图，不是「再召唤专家」的入口）。
import json
import os
import subprocess
import sys

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
TASKBOARD = os.path.join(TOOLS_DIR, 'taskboard.py')
SKILL_DIR = os.path.dirname(TOOLS_DIR)
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


def list_experts_text():
    if os.path.isfile(ROSTER):
        try:
            with open(ROSTER, 'r', encoding='utf-8') as f:
                roster = json.load(f)
            experts = roster.get('experts') if isinstance(roster, dict) else None
            if not isinstance(experts, list):
                experts = roster if isinstance(roster, list) else []
            lines = [f'专家花名册（{len(experts)} 位；deployed merged roster）：']
            for e in experts:
                if not isinstance(e, dict):
                    continue
                marks = ('（已停用）' if e.get('disabled') else '') + ('（shadowed）' if e.get('shadowed') else '')
                lines.append(f"- [{e.get('source', '?')}] {e.get('name') or e.get('title') or e.get('file', '?')}{marks}")
            return '\n'.join(lines)
        except (json.JSONDecodeError, OSError) as err:
            return f'merged roster 读取失败（{err}），以下为 bundled-core 兜底：\n' + _fmt_fallback()
    return 'expert-sources/merged/roster.json 未部署（设置页完成来源下载后出现）。当前 bundled-core 兜底花名册：\n' + _fmt_fallback()


def _fmt_fallback():
    rows = roster_fallback()
    return '\n'.join(f"- [{r['source']}] {r['name']}" for r in rows) or '（experts/ 目录为空）'


# ── tools/call 实现 ───────────────────────────────────────────────────────────

def is_write_tool(name):
    return any(t['name'] == name for t in WRITE_TOOLS)


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
        return _ok_text(json.dumps(receipt, ensure_ascii=False, indent=2))
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
