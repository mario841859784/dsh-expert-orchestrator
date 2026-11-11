#!/usr/bin/env bash
# build-b-arm.sh —— autoapprove-steal-ab-r2 对照实验 B 臂生成器（预注册工具，正文冻结后不得手改）
# r2 沿首档（2026-11-11-autoapprove-steal-ab/build-b-arm.sh），修正首跑暴露的两处生成缺陷：
#   缺陷 a（LAUNCH-NOTE.md 首跑偏差 1）：首档脚本只插入规则块、不改写落盘路径行——B 臂沿用
#     A 臂路径行导致 02-B/03-A 首跑输出互相覆盖。修正：生成 B 臂时对「产出落盘」行做
#     输出文件名 -A→-B 机械替换，并在生成后自检（B 臂落盘路径行不得再含 -A.md）。
#   缺陷 b（AA-AB-REPORT.md 失败模式归因）：首档规则 6 为技术性语义长句、探针串随之冗长。
#     r2 规则 6 重拟为短句化三要点前置后，探针串提取适配如下：反引号内原文仍取规则行
#     第一个反引号对（=三要点决策体）；新增 --probes N 可按规则号过滤（r2 判定主探针=规则 6）。
# 用法 1：build-b-arm.sh <A臂任务书> <SKILL.md> <B臂输出文件>
#         B 臂 = A 臂正文逐字节（落盘路径行 -A→-B 机械替换除外）+ persona 行后插入引用块
#         （执行指令行 + SKILL.md §3.2「阶段三新增四能力纪律」块第 4-7 条规则行逐字，"> "
#         前缀）——规则行程序化提取，零人工抄写，保证与 SKILL.md 逐字一致。
# 用法 2：build-b-arm.sh --probes [N] <SKILL.md>
#         打印第 4-7 条规则行反引号内原文（每行一条），供 grep -F 逐字探针使用；
#         可选参数 N 限定单条规则号（如 --probes 6 只打规则 6 新探针串）。
set -euo pipefail

_extract_rules() {
    # 从 SKILL.md 提取规则行 4-7 原文（块起止锚点定界，仅取规则行本体）
    awk '/^\*\*阶段三新增四能力纪律/{f=1;next} /^上述第 4-7 条/{f=0} f&&/^[4-7]\. \*\*/' "$1"
}

_rule_body() {
    # 规则行第一个反引号对内原文（r2 规则 6 重拟后三要点决策体即第一个反引号对）
    awk '{
        i = index($0, "`")
        if (i == 0) { print "错误：规则行缺反引号: " $0 > "/dev/stderr"; exit 1 }
        rest = substr($0, i + 1)
        j = index(rest, "`")
        if (j == 0) { print "错误：规则行反引号未闭合: " $0 > "/dev/stderr"; exit 1 }
        print substr(rest, 1, j - 1)
    }'
}

if [ "${1:-}" = "--probes" ]; then
    shift
    FILTER="${1:-}"
    if [ -n "${FILTER:-}" ] && [ $# -ge 2 ]; then SKILL="$2"; else SKILL="${1:-}"; FILTER=""; fi
    [ -n "$SKILL" ] || { echo "用法：build-b-arm.sh --probes [N] <SKILL.md>" >&2; exit 2; }
    if [ -n "$FILTER" ]; then
        _extract_rules "$SKILL" | awk -v n="$FILTER" '$0 ~ ("^" n "\\. \\*\\*")' | _rule_body
    else
        _extract_rules "$SKILL" | _rule_body
    fi
    exit 0
fi

[ $# -eq 3 ] || { echo "用法：build-b-arm.sh <A臂任务书> <SKILL.md> <B臂输出文件>  |  build-b-arm.sh --probes [N] <SKILL.md>" >&2; exit 1; }
A="$1"; SKILL="$2"; OUT="$3"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
{
    printf '> 以下阶段三新增四能力纪律为强约束，逐字执行：\n>\n'
    _extract_rules "$SKILL" | sed 's/^/> /'
} > "$TMP"
[ "$(grep -c '^> [4-7]\. ' "$TMP")" -eq 4 ] || { echo "错误：未从 SKILL.md 提取到完整规则行 4-7（预期 4 条）" >&2; exit 1; }

# 缺陷 a 修正：落盘路径行输出文件名 -A→-B 机械替换（仅限产出落盘行，其余逐字节）
sed "/^产出落盘：/ s/-A\.md/-B.md/g" "$A" | sed "/^persona：/r $TMP" > "$OUT"

# 生成后自检：B 臂落盘路径行必须唯一指向 -B 且不再含 -A.md
BLINE="$(grep '^产出落盘：' "$OUT")"
if ! grep '^产出落盘：' "$OUT" | grep -q -- '-B\.md'; then
    echo "错误：B 臂落盘路径行未指向 -B 文件" >&2; exit 1
fi
if grep '^产出落盘：' "$OUT" | grep -q -- '-A\.md'; then
    echo "错误：B 臂落盘路径行仍含 -A.md（路径改写失败）" >&2; exit 1
fi
echo "B 臂已生成：$OUT（规则行源自 $SKILL 逐字提取，4 条；落盘路径行已改写为 -B）"
