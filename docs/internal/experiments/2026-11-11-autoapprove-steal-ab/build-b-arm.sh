#!/usr/bin/env bash
# build-b-arm.sh —— autoapprove-steal-ab 对照实验 B 臂生成器（预注册工具，正文冻结后不得手改）
# 用法 1：build-b-arm.sh <A臂任务书> <SKILL.md> <B臂输出文件>
#         B 臂 = A 臂正文逐字节 + persona 行后插入引用块（执行指令行 + SKILL.md §3.2
#         「阶段三新增四能力纪律」块第 4-7 条规则行逐字，"> " 前缀）——规则行程序化提取，
#         零人工抄写，保证与 SKILL.md 逐字一致。
# 用法 2：build-b-arm.sh --probes <SKILL.md>
#         打印第 4-7 条规则行反引号内原文（每行一条），供 grep -F 逐字探针使用。
set -euo pipefail

_extract_rules() {
    # 从 SKILL.md 提取规则行 4-7 原文（块起止锚点定界，仅取规则行本体）
    awk '/^\*\*阶段三新增四能力纪律/{f=1;next} /^上述第 4-7 条/{f=0} f&&/^[4-7]\. \*\*/' "$1"
}

if [ "${1:-}" = "--probes" ]; then
    [ $# -eq 2 ] || { echo "用法：build-b-arm.sh --probes <SKILL.md>" >&2; exit 2; }
    _extract_rules "$2" | awk '{
        i = index($0, "`")
        if (i == 0) { print "错误：规则行缺反引号: " $0 > "/dev/stderr"; exit 1 }
        rest = substr($0, i + 1)
        j = index(rest, "`")
        if (j == 0) { print "错误：规则行反引号未闭合: " $0 > "/dev/stderr"; exit 1 }
        print substr(rest, 1, j - 1)
    }'
    exit 0
fi

[ $# -eq 3 ] || { echo "用法：build-b-arm.sh <A臂任务书> <SKILL.md> <B臂输出文件>  |  build-b-arm.sh --probes <SKILL.md>" >&2; exit 2; }
A="$1"; SKILL="$2"; OUT="$3"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
{
    printf '> 以下阶段三新增四能力纪律为强约束，逐字执行：\n>\n'
    _extract_rules "$SKILL" | sed 's/^/> /'
} > "$TMP"
[ "$(grep -c '^> [4-7]\. ' "$TMP")" -eq 4 ] || { echo "错误：未从 SKILL.md 提取到完整规则行 4-7（预期 4 条）" >&2; exit 1; }
sed "/^persona：/r $TMP" "$A" > "$OUT"
echo "B 臂已生成：$OUT（规则行源自 $SKILL 逐字提取，4 条）"
