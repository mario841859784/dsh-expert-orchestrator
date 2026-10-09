# T41（v2.8 M8-3）peer/engines 两代宿主区间静态 semver 矩阵验证记录

- 任务：T41（T29 v2.8 发布收口 6a 联动）；发布门禁第②项。
- 范围：`package.json` 的 `engines.dsh` 与 `peerDependencies["@deepseek-ai/dsh-tools"]` 两条声明在两代宿主线（`0.1.7-alpha.2` 与 `0.2.x`）上的区间覆盖核验——**静态矩阵法**，沿 v2.7.0 发布（T16）先例；本轮区间自 2.6.0 起未变，属复验而非变更。
- 方法：零依赖自实现 npm semver 区间成员判定（严格预发布比较序 + npm「候选带预发布时，区间内须存在同 `[major,minor,patch]` 元组且带预发布的比较器」规则），对每行断言 engines/peer 双列期望值；脚本 `/tmp/t29-drill/semver-matrix.mjs`（输出留档 `/tmp/t29-drill/semver-matrix.out`）。
- 验证日期：2026-10-09；基线 HEAD=533ae96（版本 bump 至 2.8.0 后、同一工作树）。

## 一、结论

**10/10 行全过（exit 0）：两代宿主 `0.1.7-alpha.2` 与 `0.2.1-alpha.1`（及 `0.2.0-rc.1`、`0.2.1`、`0.1.9` 稳定线）双双命中 engines 与 peer；`0.2.2-alpha.x`、`0.3.0`、`0.3.0-alpha.x` 正确落选。区间无需变更。**

## 二、区间原文（本轮未动，2.6.0 起沿用）

```
engines.dsh          = ">=0.1.7-alpha.2 <0.2.0-0 || >=0.2.0-rc.1 <0.3.0-0 || >=0.2.1-0 <0.3.0-0"
peer dsh-tools       = ">=0.1.6-alpha.1 <0.1.7-0 || >=0.1.7-alpha.2 <0.2.0-0 || >=0.2.0-rc.1 <0.3.0-0 || >=0.2.1-0 <0.3.0-0"
```

## 三、矩阵实测输出（2026-10-09，exit 0）

```
version          engines  peer    note
0.1.6-alpha.1    false   true    PASS  peer-only 0.1.6-alpha line (kept since 2.5.1)
0.1.7-alpha.1    false   false   PASS  negative: alpha.1 < alpha.2 on the same tuple
0.1.7-alpha.2    true    true    PASS  old-generation host (verified generation)
0.1.9            true    true    PASS  0.1.x stable within <0.2.0-0
0.2.0-rc.1       true    true    PASS  rc branch appended in 2.5.4
0.2.1-alpha.1    true    true    PASS  current running host line
0.2.1            true    true    PASS  0.2.1 stable within >=0.2.1-0
0.2.2-alpha.1    false   false   PASS  negative: 0.2.2 patch-prerelease line needs its own branch (documented note)
0.3.0            false   false   PASS  negative: 0.3.0 release excluded by the <0.3.0-0 upper bounds
0.3.0-alpha.1    false   false   PASS  negative: excluded too — the -0 upper bound sorts numeric-0 BEFORE alpha, so every 0.3.0 prerelease exceeds it
MATRIX: 10/10
```

## 四、两处判定细节（避免后世误读）

1. **`0.2.2-alpha.x` 落选机制**：数值上它落在 `>=0.2.1-0 <0.3.0-0` 之内，但 npm 严格语义要求「带预发布的候选版本须被**同元组**带预发布的比较器接纳」——`>=0.2.1-0` 在元组 `(0,2,1)` 上、候选在 `(0,2,2)` 上，元组不同即整体落选。这正是 2.6.0 条目预留的「每个 0.2.x patch 预发布线需自追加分支」注记，本轮复核仍成立。
2. **`0.3.0-alpha.x` 落选机制（与 1 方向相反）**：上界 `<0.3.0-0` 自身带预发布且元组 `(0,3,0)` 与候选相同，看似应命中；但 `0` 是数字标识，semver 序里数字标识先于字母数字标识（`0.3.0-0 < 0.3.0-alpha.1`），故一切 `0.3.0-alpha.x` 都**大于**上界 `0.3.0-0` 而落选。`-0` 下界（`>=0.2.1-0`）放行同元组预发布、`-0` 上界反而挡住同元组预发布——两侧语义不对称是本区间写法的实际效果。

## 五、验证边界（用户裁决 1B，沿 2.6.0/2.7.0/2.7.1 立场）

本记录为**静态声明面**验证；未在任一宿主上做真实装载实测。现宿主 `0.2.1-alpha.1` 的热挂载/端到端验证、`0.1.7-alpha.2` 线的宿主重启级验证，均沿用既有裁决标注「待用户重启后补测」。
