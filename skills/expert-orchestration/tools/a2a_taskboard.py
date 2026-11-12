#!/usr/bin/env python3
# M1：A2A 最小 HTTP 服务端（exposure-crypto-trust 报告 §5.4/§2.3 设计落地）。
#
# 定位：把任务板/花名册以 A2A JSON-RPC over HTTP 形态导出，让外部协调者（如 hermes 或任何
# A2A client）跨进程给 dsh 派任务。复用 mcp_taskboard.py「子进程调用 taskboard.py」骨架
# （import 同目录 mcp_taskboard 复用 run_taskboard/parse_receipt/花名册解析），零依赖
# （python3 标准库 http.server，无 SDK）。
#
# MVP 方法面（报告 §5.4：MVP 只实现 message/send 同步 + tasks/get 轮询）：
# - message/send：新建任务板任务（taskboard.py create），返回 A2A task 对象。缺省按规范
#   阻塞语义轮询至终态/中断态（completed/failed/rejected/canceled/input-required）——
#   上限 --block-max-sec（默认 300s，env DSH_TASKBOARD_A2A_BLOCK_MAX_SEC）；超时返回当前
#   非终态任务对象（对规范「MUST wait until terminal」的如实偏差：文件板的任务由外部
#   编排面推进，服务端不代跑，超时宁可交回当前态也不无限挂起）；configuration.
#   returnImmediately=true 时跳过阻塞立即返回（规范定义的行为）。状态映射：draft/pending/
#   ready→submitted、running→working、done→completed、failed→failed、rejected→rejected、
#   escalated→input-required（等用户处置=中断态，阻塞中的 send 因此返回）。
# - tasks/get：轮询任务态（taskboard.py show），未知 id → -32001 TaskNotFoundError。
# - 其余方法（message/stream、tasks/cancel、tasks/list、tasks/resubscribe、push 配置族）：
#   具名拒——streaming/resubscribe → -32004 UnsupportedOperationError（卡面 capabilities
#   照实 false）；push 配置族 → -32003 PushNotificationNotSupportedError（规范：push=false
#   时相关操作 MUST return PushNotificationNotSupportedError）。
#
# 鉴权先于暴露（报告 §5.4 前置，MCP transports 2025-06-18 Security Warning 三条最低配）：
# - Origin 校验 MUST：请求带 Origin 头时必须命中白名单（缺省白名单为空=一律拒——非浏览器
#   客户端不带 Origin 不受影响；DNS rebinding 的浏览器跨源请求必带 Origin 被拦）。
#   --allow-origin / env DSH_TASKBOARD_A2A_ALLOW_ORIGIN（逗号分隔）扩白名单。
# - 本地绑定 SHOULD：缺省 --host 127.0.0.1；显式换绑由操作者自担。
# - 认证 SHOULD（本服务按报告「不做无鉴权 HTTP 面——哪怕本地演示也不裸奔」执行为 MUST）：
#   POST JSON-RPC 一律要求 Authorization: Bearer <token>——token 取 --token >
#   env DSH_TASKBOARD_A2A_TOKEN > 启动时生成（a2a-<32hex>，stderr 横幅打印），常时时间比较。
#   GET /.well-known/agent-card.json 为发现面不设防（公开元数据，A2A 发现语义；卡面
#   securitySchemes 如实声明 POST 需 bearer）。
# - Host 头校验（DNS rebinding 纵深，非规范强制）：Host 主机名必须 ∈ {127.0.0.1, localhost,
#   ::1} ∪ 显式绑定主机 ∪ --allow-host/env DSH_TASKBOARD_A2A_ALLOW_HOST——rebinding 场景
#   浏览器发出的 Host 是攻击者域名，一并拦截（GET 无 Origin 头时的兜底）。
#
# 写面纪律（与 MCP 导出面同款，方向 4 口径）：message/send 落任务板属写面——
# DSH_TASKBOARD_A2A_WRITES=1 opt-in 才暴露（缺省具名拒 writes_disabled）；外部写入=
# 代理转达的板面变更，审计走 CLI 事件流自报口径（create 回执带 event_seq/revision 对账锚点，
# A2A task.metadata 以 dsh:* 键回显）。单向导出：不提供任何「召唤专家」入口。
import argparse
import hmac
import json
import os
import secrets
import signal
import sys
import threading
import time
import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))

# ── A2A 协议常量（v0.3.0）─────────────────────────────────────────────────────
PROTOCOL_VERSION = '0.3.0'
# JSON-RPC 2.0 标准错误码 + A2A 专有错误码（v0.3.0 §8：-32001 TaskNotFound /
# -32002 TaskNotCancelable / -32003 PushNotificationNotSupported /
# -32004 UnsupportedOperation / -32005 ContentTypeNotSupported）
ERR_PARSE = -32700
ERR_INVALID_REQUEST = -32600
ERR_METHOD_NOT_FOUND = -32601
ERR_INVALID_PARAMS = -32602
ERR_INTERNAL = -32603
ERR_TASK_NOT_FOUND = -32001
ERR_PUSH_NOT_SUPPORTED = -32003
ERR_UNSUPPORTED_OP = -32004
ERR_CONTENT_TYPE = -32005

# 板面状态 → A2A TaskState（v0.3.0 枚举：submitted/working/input-required/completed/
# canceled/failed/rejected/auth-required/unknown）。escalated=等用户处置 → input-required
# （中断态：阻塞中的 message/send 在此返回，不吞升级出口）。
STATE_MAP = {
    'draft': 'submitted', 'pending': 'submitted', 'ready': 'submitted',
    'running': 'working', 'done': 'completed', 'failed': 'failed',
    'rejected': 'rejected', 'escalated': 'input-required',
}
# 阻塞轮询的返回条件：终态（completed/failed/canceled/rejected）+ 中断态（input-required）
BLOCK_EXIT_STATES = {'completed', 'failed', 'canceled', 'rejected', 'input-required'}

MAX_BODY_BYTES = 1_000_000  # 请求体上限（防滥用基线；任务书文本远小于此）


def load_plugin_version():
    """卡面 version：package.json 单一事实源（仓库根相对本文件 ../../..）；
    部署副本缺 package.json 时 'unknown' 如实占位（gen-agent-card.mjs 同口径）。"""
    pkg = os.path.normpath(os.path.join(TOOLS_DIR, '..', '..', '..', 'package.json'))
    try:
        with open(pkg, 'r', encoding='utf-8') as f:
            v = json.load(f).get('version')
        return v if isinstance(v, str) and v.strip() else 'unknown'
    except (OSError, json.JSONDecodeError, ValueError):
        return 'unknown'


# ── A2A task 对象构造 ─────────────────────────────────────────────────────────

def iso_ts(ms):
    """板面 ms 时间戳 → ISO8601 UTC（A2A status.timestamp 语义；非法值如实置空）。"""
    try:
        return datetime.datetime.fromtimestamp(int(ms) / 1000, datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    except (TypeError, ValueError, OSError, OverflowError):
        return ''


def a2a_task(t, context_id, revision=None, event_seq=None):
    """板面任务对象 → A2A Task（v0.3.0：id/contextId/kind/status/metadata）。
    metadata 以 dsh:* 键回显板面事实（对账面）：boardStatus=原始板状态、owner、
    revision/eventSeq=板级对账锚点。artifacts/history MVP 不给（文件板无产物面）。"""
    status = t.get('status', '')
    meta = {'dsh:boardStatus': status, 'dsh:owner': t.get('owner') or ''}
    if revision is not None:
        meta['dsh:revision'] = revision
    if event_seq is not None:
        meta['dsh:eventSeq'] = event_seq
    return {
        'id': t.get('id', ''),
        'contextId': context_id,
        'kind': 'task',
        'status': {'state': STATE_MAP.get(status, 'unknown'), 'timestamp': iso_ts(t.get('updated'))},
        'metadata': meta,
    }


def _resolve_context_id(message, tid):
    """contextId：客户端随 message 提供则原样回显（A2A 会话分组语义），缺省按
    「一块板任务=一个上下文」派生 dsh-<任务id>（确定性、重启后 tasks/get 仍一致）。"""
    cid = message.get('contextId') if isinstance(message, dict) else None
    return cid if isinstance(cid, str) and cid else f'dsh-{tid}'


# ── 卡面（与 scripts/gen-agent-card.mjs 同口径；N1 安全声明同款字面）───────────

def build_card(url, host, writes_enabled_flag, block_max_sec):
    import mcp_taskboard as mtb  # 延迟导入：env 注入须先于 import（见 main）
    deployed = mtb.deployed_roster_experts()
    if deployed is not None:
        experts, roster_source = deployed, 'deployed-merged'
    else:
        experts, roster_source = mtb.roster_fallback(), 'bundled-core-fallback'
    skills = []
    for i, e in enumerate(experts):
        if not isinstance(e, dict) or e.get('disabled') or e.get('shadowed'):
            continue
        nm = e.get('name') or e.get('title') or f'expert-{i}'
        skills.append({
            'id': f"expert-{str(nm).replace(' ', '-')}",
            'name': str(nm),
            'description': f"领域专家（来源 {e.get('source', 'unknown')}）：以该专家 persona 承接任务板子任务并交付——经任务板 claim/done 协作，身份为板面自报（防误用不防伪造）。",
            'tags': ['expert', str(e.get('source', 'unknown'))],
        })
    return {
        'name': 'dsh-expert-orchestrator',
        'description': '专家编排节点：分诊 → PM 规划 → 专家委派 → 依赖 DAG 任务板 → 分级交付门禁。'
                       'A2A JSON-RPC 最小面由本服务提供（message/send 同步 + tasks/get 轮询，写面 opt-in）；'
                       '任务板与专家花名册另经 MCP（tools/mcp_taskboard.py，缺省只读）导出。',
        'url': url,
        'version': load_plugin_version(),
        'protocolVersion': PROTOCOL_VERSION,
        'preferredTransport': 'JSONRPC',
        'capabilities': {'streaming': False, 'pushNotifications': False, 'stateTransitionHistory': False},
        'defaultInputModes': ['text/plain'],
        'defaultOutputModes': ['text/plain'],
        'securitySchemes': {
            'bearer': {
                'type': 'http',
                'scheme': 'bearer',
                'description': 'A2A JSON-RPC 端点要求 bearer token；凭证经带外通道分发（服务端启动输出 / env 注入），不在卡面承载。',
            },
        },
        'security': [{'bearer': []}],
        'skills': skills,
        'dsh:rosterSource': roster_source,
        'dsh:writeFace': 'message/send 为写面（服务端 DSH_TASKBOARD_A2A_WRITES=1 opt-in，缺省具名拒 writes_disabled）；'
                         'tasks/get 只读。外部写入=代理转达的板面变更（自报口径）。',
        'dsh:blocking': f'message/send 缺省阻塞轮询至终态/中断态（上限 {block_max_sec}s，DSH_TASKBOARD_A2A_BLOCK_MAX_SEC 可调）；'
                        'configuration.returnImmediately=true 立即返回；超时如实返回当前非终态。',
        'dsh:bindHost': host,
    }


# ── JSON-RPC 处理 ─────────────────────────────────────────────────────────────

def extract_text_parts(message):
    """message.parts → 纯文本拼接；出现非 text part 返回 (None, kind) 交由调用方
    按 ContentTypeNotSupportedError 具名拒（MVP 只支持 text/plain，卡面 defaultInputModes
    如实声明——宁拒勿猜，不静默丢弃非文本载荷）。"""
    parts = message.get('parts')
    if not isinstance(parts, list) or not parts:
        return None, None
    texts, bad = [], None
    for p in parts:
        if isinstance(p, dict) and p.get('kind') == 'text' and isinstance(p.get('text'), str):
            texts.append(p['text'])
        else:
            bad = (p or {}).get('kind') if isinstance(p, dict) else str(type(p).__name__)
            break
    if bad is not None:
        return None, bad
    # 不做首尾剥离：首行=标题的映射要求「首行为空」如实触发具名拒（宁拒勿猜，不静默改写意图）
    return '\n'.join(texts), None


def split_title_desc(text):
    """A2A message 文本 → 板面 create 入参：首行=标题、其余=完成标准（desc）。
    纯单行文本时 desc 为空（完成标准后补走 progress，板面语义不变）。"""
    lines = [ln for ln in text.split('\n')]
    title = (lines[0] or '').strip()
    desc = '\n'.join(lines[1:]).strip()
    return title, desc


class A2ABoardServer:
    """JSON-RPC 方法面实现（与 HTTP 层解耦，便于单测直接驱动 dispatch）。"""

    def __init__(self, token, writes_enabled_flag, block_max_sec):
        import mcp_taskboard as mtb
        self.mtb = mtb
        self.token = token.encode('utf-8')
        self.writes_enabled_flag = writes_enabled_flag
        self.block_max_sec = block_max_sec

    def error(self, code, message, data=None):
        err = {'code': code, 'message': message}
        if data is not None:
            err['data'] = data
        return {'jsonrpc': '2.0', 'id': None, 'error': err}

    def dispatch(self, req):
        """返回 (status_code, response_obj)；response_obj=None 表示通知无回包。"""
        if not isinstance(req, dict) or req.get('jsonrpc') != '2.0' or not isinstance(req.get('method'), str):
            return 400, self.error(ERR_INVALID_REQUEST, 'invalid request: 须为 {"jsonrpc":"2.0","method":...} JSON-RPC 信封')
        method, rid = req['method'], req.get('id')
        if rid is None:
            return 202, None  # JSON-RPC 通知：无回包（MVP 一律接受并丢弃）
        try:
            result = self._handle(method, req.get('params') or {})
            return 200, {'jsonrpc': '2.0', 'id': rid, 'result': result}
        except _RpcError as e:
            return e.http_status, {'jsonrpc': '2.0', 'id': rid, 'error': e.envelope()}
        except Exception as e:  # 兜底：绝不裸 traceback，统一 InternalError
            return 500, {'jsonrpc': '2.0', 'id': rid,
                         'error': {'code': ERR_INTERNAL, 'message': f'internal error: {type(e).__name__}: {e}'}}

    def _handle(self, method, params):
        if method == 'message/send':
            return self._message_send(params)
        if method == 'tasks/get':
            return self._tasks_get(params)
        if method.startswith('tasks/pushNotificationConfig'):
            raise _RpcError(ERR_PUSH_NOT_SUPPORTED, 'PushNotificationNotSupportedError: 本服务 capabilities.pushNotifications=false（MVP 不实现 push）')
        if method in ('message/stream', 'tasks/resubscribe', 'tasks/cancel', 'tasks/list'):
            raise _RpcError(ERR_UNSUPPORTED_OP, 'UnsupportedOperationError: MVP 方法面=message/send 同步 + tasks/get 轮询'
                            '（streaming=false 故 stream/resubscribe 不可用；cancel/list 留待后续版本）')
        if method == 'initialize':
            # 宽容面：部分 client 在握手期发 A2A initialize——按 v0.3.0 回协议版本（无状态）
            return {'protocolVersion': PROTOCOL_VERSION}
        raise _RpcError(ERR_METHOD_NOT_FOUND, f'method not found: {method}（MVP 方法面=message/send、tasks/get）')

    # ── message/send ──────────────────────────────────────────────────────
    def _message_send(self, params):
        if not self.writes_enabled_flag:
            raise _RpcError(ERR_UNSUPPORTED_OP,
                            'writes_disabled: message/send 落任务板属写面——缺省只读；确认开放外部派任务时以 '
                            'DSH_TASKBOARD_A2A_WRITES=1 启动本服务（外部写入=代理转达的板面变更）',
                            http_status=200)
        message = params.get('message')
        if not isinstance(message, dict):
            raise _RpcError(ERR_INVALID_PARAMS, 'params.message 必填（A2A Message 对象）')
        if not isinstance(message.get('messageId'), str) or not message.get('messageId'):
            raise _RpcError(ERR_INVALID_PARAMS, 'message.messageId 必填（发送方生成的唯一 id）')
        if message.get('taskId'):
            raise _RpcError(ERR_UNSUPPORTED_OP,
                            'task_continuation_unsupported: MVP 不支持 message.taskId 续话——每次 message/send 新建任务；'
                            '对话续写/进度补充请走任务板 progress（MCP 面）')
        text, bad_kind = extract_text_parts(message)
        if text is None:
            if bad_kind is not None:
                raise _RpcError(ERR_CONTENT_TYPE, f'ContentTypeNotSupportedError: 非 text part（kind={bad_kind}）不在 MVP 支持面（defaultInputModes=text/plain）')
            raise _RpcError(ERR_INVALID_PARAMS, 'message.parts 必填且须含至少一个 text part')
        title, desc = split_title_desc(text)
        if not title:
            raise _RpcError(ERR_INVALID_PARAMS, 'message 文本首行为空——任务标题须非空（首行=标题，其余行=完成标准）')
        # metadata 通道（params.metadata 与 message.metadata 合并，message 优先）：dsh:owner/
        # dsh:scope 显式声明才透传——外部协调者自报归属/关联域，与 MCP 写工具参数同口径。
        meta = {}
        for src in (params.get('metadata'), message.get('metadata')):
            if isinstance(src, dict):
                meta.update(src)
        argv = ['--json', 'create', title]
        owner = meta.get('dsh:owner')
        if isinstance(owner, str) and owner.strip():
            argv += ['--owner', owner.strip()]
        if desc:
            argv += ['--desc', desc]
        scope = meta.get('dsh:scope')
        if isinstance(scope, str) and scope.strip():
            argv += ['--scope', scope.strip()]
        elif isinstance(scope, list) and scope:
            argv += ['--scope', ','.join(str(s).strip() for s in scope if str(s).strip())]
        r = self.mtb.run_taskboard(argv)
        receipt = self.mtb.parse_receipt(r['stdout'])
        if r['code'] != 0:
            detail = receipt if receipt else (r['stderr'] or r['stdout']).strip()
            raise _RpcError(ERR_INVALID_PARAMS, f'taskboard 拒绝（exit {r["code"]}）：{json.dumps(detail, ensure_ascii=False) if isinstance(detail, dict) else detail}',
                            http_status=200)
        if not isinstance(receipt, dict) or not receipt.get('ok'):
            raise _RpcError(ERR_INTERNAL, 'taskboard 回执不可解析（无 --json 信封）', http_status=200)
        task = (receipt.get('data') or {}).get('task') or {}
        tid = task.get('id')
        if not tid:
            raise _RpcError(ERR_INTERNAL, 'taskboard create 回执缺任务 id', http_status=200)
        ctx_id = _resolve_context_id(message, tid)
        result = a2a_task(task, ctx_id,
                          revision=receipt.get('revision'), event_seq=receipt.get('event_seq'))
        result['metadata']['dsh:messageId'] = message.get('messageId')
        # 阻塞语义（v1.0 §3.2/§2.1 一手规范）：returnImmediately=true 立即返回；缺省 MUST wait
        # 至终态/中断态——文件板无服务端执行体，落地为轮询 show 至 BLOCK_EXIT_STATES 或上限；
        # 超时如实返回当前态（偏差已在文件头声明，不虚构终态）。
        cfg = params.get('configuration') or {}
        if not cfg.get('returnImmediately') and self.block_max_sec > 0:
            deadline = time.monotonic() + self.block_max_sec
            while time.monotonic() < deadline:
                cur = self._fetch_board_task(tid)
                if cur is None:
                    break  # 板面读失败：交回创建态（上方 result），不虚构状态
                state = STATE_MAP.get(cur[0].get('status'), 'unknown')
                if state in BLOCK_EXIT_STATES:
                    result = a2a_task(cur[0], ctx_id, revision=cur[1])
                    result['metadata']['dsh:messageId'] = message.get('messageId')
                    break
                time.sleep(0.5)
        return result

    def _fetch_board_task(self, tid):
        """show 快照 → (task, revision)；读失败返回 None（阻塞轮询不因瞬时读错退出）。"""
        r = self.mtb.run_taskboard(['--json', 'show', tid])
        receipt = self.mtb.parse_receipt(r['stdout'])
        if r['code'] == 0 and isinstance(receipt, dict) and receipt.get('ok'):
            t = (receipt.get('data') or {}).get('task')
            if isinstance(t, dict):
                return t, receipt.get('revision')
        return None

    # ── tasks/get ─────────────────────────────────────────────────────────
    def _tasks_get(self, params):
        tid = params.get('id')
        if not isinstance(tid, str) or not tid:
            raise _RpcError(ERR_INVALID_PARAMS, 'params.id 必填（任务板任务 id，如 T5）')
        cur = self._fetch_board_task(tid)
        if cur is None:
            raise _RpcError(ERR_TASK_NOT_FOUND, f'TaskNotFoundError: 任务 {tid} 不存在或不可读', http_status=200)
        t, revision = cur
        return a2a_task(t, f'dsh-{tid}', revision=revision)


class _RpcError(Exception):
    """JSON-RPC 错误（A2A over HTTP：协议错误回 200 + error 信封；信封级错误回 4xx/5xx）。"""

    def __init__(self, code, message, data=None, http_status=200):
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data
        self.http_status = http_status

    def envelope(self):
        err = {'code': self.code, 'message': self.message}
        if self.data is not None:
            err['data'] = self.data
        return err


# ── HTTP 层（鉴权三件 + 请求体边界）────────────────────────────────────────────

def make_handler(core, card_fn, allowed_origins, allowed_hosts, bind_host):
    loopback_hosts = {'127.0.0.1', 'localhost', '::1'}
    if bind_host and bind_host not in ('0.0.0.0', '::', ''):
        loopback_hosts.add(bind_host)
    loopback_hosts |= allowed_hosts

    class Handler(BaseHTTPRequestHandler):
        server_version = 'dsh-a2a-taskboard'
        protocol_version = 'HTTP/1.1'

        def _send_json(self, status, obj, close=False, extra_headers=None):
            body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
            if close:
                # keep-alive 语义：请求体未消费就回错误时必须断连——残体会被当作下一请求行
                # 解析（实测出 501「Unsupported method」），宁可断连不毒化连接复用。
                self.close_connection = True
                self.send_response(status)
                self.send_header('Connection', 'close')
            else:
                self.send_response(status)
            for k, v in (extra_headers or {}).items():
                self.send_header(k, v)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _guard_transport(self):
            """鉴权三件中的两件（MUST 级）：Origin 白名单 + Host 头校验。违者 403（断连，
            调用方须负责未读请求体的场景——403 前不读体，防未鉴权面的资源消耗）。"""
            host = self.headers.get('Host') or ''
            hostname = host.rsplit(':', 1)[0].strip('[]') if host else ''
            if not hostname or hostname not in loopback_hosts:
                self._send_json(403, {'error': 'forbidden', 'detail': f'Host 头不在允许集（rebinding 纵深校验）：{hostname or "（缺失）"}'}, close=True)
                return False
            origin = self.headers.get('Origin')
            if origin is not None and origin not in allowed_origins:
                # MCP transports MUST 条款：Origin 校验防 DNS rebinding——非浏览器客户端不带
                # Origin 不受影响；带 Origin 而不在白名单（缺省空=全部拒）一律 403。
                self._send_json(403, {'error': 'forbidden', 'detail': f'Origin 不在白名单（缺省空名单=全部拒，--allow-origin 扩）：{origin}'}, close=True)
                return False
            return True

        def do_GET(self):
            if not self._guard_transport():
                return
            if self.path.split('?')[0] == '/.well-known/agent-card.json':
                self._send_json(200, card_fn())
                return
            self._send_json(404, {'error': 'not_found', 'detail': '发现路径=/.well-known/agent-card.json；JSON-RPC 端点=POST /'})

        def do_POST(self):
            if not self._guard_transport():
                return
            if self.path.split('?')[0] != '/':
                self._send_json(404, {'error': 'not_found', 'detail': 'JSON-RPC 端点=POST /（卡面 url 绑定）'}, close=True)
                return
            # 认证（报告：不做无鉴权 HTTP 面——SHOULD 按 MUST 执行）：Bearer 常时时间比较。
            # 401 前不读请求体（防未鉴权面的资源消耗），错误响应断连（见 _send_json close）。
            auth = self.headers.get('Authorization') or ''
            expect = 'Bearer '
            supplied = auth[len(expect):].encode('utf-8') if auth.startswith(expect) else b''
            if not supplied or not hmac.compare_digest(supplied, core.token):
                self._send_json(401, {'error': 'unauthorized', 'detail': '须携带 Authorization: Bearer <token>（凭证带外分发）'},
                                close=True, extra_headers={'WWW-Authenticate': 'Bearer'})
                return
            try:
                n = int(self.headers.get('Content-Length') or 0)
            except ValueError:
                n = -1
            if n < 0 or n > MAX_BODY_BYTES:
                self._send_json(413, {'error': 'payload_too_large', 'detail': f'请求体须为 0<Content-Length≤{MAX_BODY_BYTES}'}, close=True)
                return
            raw = self.rfile.read(n) if n else b''  # 体已在鉴权后消费：keep-alive 复用安全
            try:
                req = json.loads(raw.decode('utf-8'))
            except (json.JSONDecodeError, UnicodeDecodeError):
                self._send_json(400, {'jsonrpc': '2.0', 'id': None,
                                      'error': {'code': ERR_PARSE, 'message': 'Parse error: 请求体非合法 JSON'}})
                return
            status, resp = core.dispatch(req)
            if resp is None:
                self.send_response(202)
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
            self._send_json(status, resp)

        def log_message(self, fmt, *args):  # 访问日志走 stderr（stdout 保持干净）
            sys.stderr.write('a2a: ' + (fmt % args) + '\n')

    return Handler


# ── 启动 ──────────────────────────────────────────────────────────────────────

def parse_csv_env(name):
    raw = os.environ.get(name, '').strip()
    return {s.strip() for s in raw.split(',') if s.strip()} if raw else set()


def main(argv=None):
    ap = argparse.ArgumentParser(description='dsh 任务板 A2A 最小 HTTP 服务端（message/send 同步 + tasks/get 轮询）')
    ap.add_argument('--host', default='127.0.0.1', help='绑定地址（缺省 127.0.0.1，MCP transports SHOULD 条款）')
    ap.add_argument('--port', type=int, default=8089, help='监听端口（缺省 8089；0=临时端口）')
    ap.add_argument('--board', help='任务板路径（缺省沿 taskboard.py 语义=<cwd>/.expert-taskboard.json）；'
                                    'env DSH_TASKBOARD_A2A_BOARD 同义，参数优先')
    ap.add_argument('--skill-dir', help='技能目录根（花名册解析锚点；env DSH_TASKBOARD_A2A_SKILL_DIR 同义），'
                                        '缺省=本脚本所在技能目录')
    ap.add_argument('--token', help='bearer token（env DSH_TASKBOARD_A2A_TOKEN 同义，参数优先）；'
                                    '两者都未提供时启动生成 a2a-<32hex> 并在 stderr 横幅打印')
    ap.add_argument('--allow-origin', help='Origin 白名单扩项（逗号分隔；缺省空名单=带 Origin 一律拒；'
                                           'env DSH_TASKBOARD_A2A_ALLOW_ORIGIN 同义）')
    ap.add_argument('--allow-host', help='Host 头白名单扩项（逗号分隔；env DSH_TASKBOARD_A2A_ALLOW_HOST 同义）')
    ap.add_argument('--block-max-sec', type=int, default=None,
                    help='message/send 缺省阻塞轮询上限秒数（缺省 300；env DSH_TASKBOARD_A2A_BLOCK_MAX_SEC 同义；0=不阻塞）')
    args = ap.parse_args(argv)

    # --board/--skill-dir 经既有 MCP 骨架 env 通道注入（run_taskboard/花名册解析同源复用）；
    # 必须先于 import mcp_taskboard（其模块级常量读 env）。
    board = args.board or os.environ.get('DSH_TASKBOARD_A2A_BOARD', '').strip() or ''
    if board:
        os.environ['DSH_TASKBOARD_MCP_BOARD'] = board
    skill_dir = args.skill_dir or os.environ.get('DSH_TASKBOARD_A2A_SKILL_DIR', '').strip() or ''
    if skill_dir:
        os.environ['DSH_TASKBOARD_MCP_SKILL_DIR'] = skill_dir
    import mcp_taskboard as mtb  # noqa: E402  （env 注入后导入——骨架复用点）

    token = args.token or os.environ.get('DSH_TASKBOARD_A2A_TOKEN', '').strip() or ''
    token_generated = False
    if not token:
        token = 'a2a-' + secrets.token_hex(16)  # 不裸奔：缺省即有凭证（stderr 横幅交操作者带外转交）
        token_generated = True
    writes_on = bool(os.environ.get('DSH_TASKBOARD_A2A_WRITES', '').strip())
    block_max = args.block_max_sec
    if block_max is None:
        raw = os.environ.get('DSH_TASKBOARD_A2A_BLOCK_MAX_SEC', '').strip()
        try:
            block_max = int(raw) if raw else 300
        except ValueError:
            print(f'警告：DSH_TASKBOARD_A2A_BLOCK_MAX_SEC={raw!r} 非整数——按 300 处理', file=sys.stderr)
            block_max = 300
    block_max = max(0, block_max)

    allowed_origins = parse_csv_env('DSH_TASKBOARD_A2A_ALLOW_ORIGIN')
    if args.allow_origin:
        allowed_origins |= {s.strip() for s in args.allow_origin.split(',') if s.strip()}
    allowed_hosts = parse_csv_env('DSH_TASKBOARD_A2A_ALLOW_HOST')
    if args.allow_host:
        allowed_hosts |= {s.strip() for s in args.allow_host.split(',') if s.strip()}

    core = A2ABoardServer(token, writes_on, block_max)
    bind_for_url = args.host if args.host in ('127.0.0.1', 'localhost', '::1') else '127.0.0.1'

    # 先绑定端口拿实际 port（--port 0=临时端口），再装 handler（卡面 url 依赖实际端口）。
    httpd = ThreadingHTTPServer((args.host, args.port), None)
    port = httpd.server_address[1]
    card_url = f'http://{bind_for_url}:{port}/'
    httpd.RequestHandlerClass = make_handler(core, lambda: build_card(card_url, args.host, writes_on, block_max),
                                             allowed_origins, allowed_hosts, args.host)
    httpd.daemon_threads = True

    def _term(_sig, _frm):
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, _term)
    signal.signal(signal.SIGINT, _term)

    # 启动横幅（stderr；stdout 保持干净）。token 仅生成态回显——显式提供不回显（不放大秘密面）。
    print(f'A2A_LISTEN {card_url}', file=sys.stderr)
    print(f'A2A_PROTOCOL {PROTOCOL_VERSION}（message/send 同步 + tasks/get 轮询；streaming/push 照实 false）', file=sys.stderr)
    if token_generated:
        print(f'A2A_TOKEN {token}', file=sys.stderr)
        print('A2A_TOKEN_NOTE 凭证为启动生成（未配置 DSH_TASKBOARD_A2A_TOKEN）——请带外交给调用方；'
              '重启即轮换，需固定凭证请以 env/--token 提供', file=sys.stderr)
    else:
        print('A2A_TOKEN 来源=env/--token（不回显）', file=sys.stderr)
    print(f'A2A_WRITES {"open（message/send 可写）" if writes_on else "closed（缺省只读；message/send 具名拒 writes_disabled，DSH_TASKBOARD_A2A_WRITES=1 开）"}', file=sys.stderr)
    print(f'A2A_BOARD {board or "（沿 taskboard.py 缺省：<cwd> 板）"}', file=sys.stderr)
    print(f'A2A_BLOCK_MAX_SEC {block_max}', file=sys.stderr)
    sys.stderr.flush()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == '__main__':
    main()
