# T14（WP-6b）两代宿主技能声明行验证记录

- 任务：T14 / WP-6b 零 token 用户手势（v2.7 #14/#15 收官）；2026-10-09 回炉更新（评审 m1791480965012561：1 阻断 B1 + 1 重要 M1）。
- 范围：验收 (e)「两代宿主技能注册均可加载」+ (b)「`/expert-名称` 注入不消耗模型调用」的机制与实测证据。
- 实测工具：`scripts/verify-gesture-declaration.mjs`（零第三方依赖；**先解析产物 cordis.patch.yml 的 `!!js` 挂载公式、再以解析所得目录挂载实测**——回炉 B1-配套①，见 §六；对任意世代宿主 node_modules 可复跑；exit 2=宿主模块不可用即跳过，不并入 npm test）。
- 验证日期：2026-10-09（初版与回炉同日）；基线 HEAD=52c3ffc（T13 后工作树，T14 未提交改动）。

## 一、结论

**回炉修复 B1 后复测：解析产物声明的挂载根 = [`<dst>/skills`, `<dst>/skills/expert-gestures`]（`skills` 段在位），两代宿主（0.1.7-alpha.2 与 0.2.1-alpha.1）真实代码上同一脚本 14 项检查全部通过，注册计数 = 13（2 既有 + 11 手势）。** 手势层 = `skill-filesystem` 声明行 `customSkillDirs` 的第二个挂载根（`skills/expert-gestures`）+ 11 份 frontmatter `disable-model-invocation: true` 的技能文件；两代宿主对该声明的解析（zod schema、frontmatter 键、手势正则、pre-step 注入、目录过滤）同构。

> **勘误（回炉 B1-配套②）**：本记录初版把「customSkillDirs = [skills, skills/expert-gestures]」写成已部署事实——彼时产物实为 `[skills, expert-gestures]`（派生锚替换丢掉 `'skills'` 段，声明挂载部署器永不创建的 `<dst>/expert-gestures`），部署面手势注册 0 个、`/expert-<name>` 到达即死且静默无告警。初版「12 项 PASS」由 verify 脚本 ③ 以仓库路径硬编码构造挂载（自指检查）得出，盖住了该缺陷。本节结论以回炉后**解析产物**复测为准，证据见 §二/§六。

## 二、实测证据（live，非纯静态；挂载目录全部解析自产物 cordis.patch.yml）

### ① 当前宿主线 0.2.1-alpha.1（参考 checkout `/vol2/@appcenter/Harness/server/node_modules`；`dsh-skill-filesystem`/`dsh-skill`/`dsh-tool-skill` version 实测 0.2.1-alpha.1）

```
$ node scripts/verify-gesture-declaration.mjs
host modules: /vol2/@appcenter/Harness/server/node_modules
declaration (parsed from cordis.patch.yml): customSkillDirs = [<scratch>/.agent-presets/expert-orchestrator/skills, <scratch>/.agent-presets/expert-orchestrator/skills/expert-gestures]
① parsed declaration shape: root#2 keeps the skills segment (review B1 lock)
  ✅ root#1 = <DSH_HOME>/.agent-presets/expert-orchestrator/skills
  ✅ root#2 = root#1/expert-gestures (= <dst>/skills/expert-gestures, the deployer layout)
② gesture dir (parsed root#2) mounts with modelInvocable:false ×11 + userInvocable:true
  ✅ exactly 11 candidates, all expert-*（expert-backend-engineer … expert-tech-writer 共 11 项列举）
  ✅ all modelInvocable:false (userInvocable:true)
  ✅ catalog filter (isModelInvocable) excludes all → zero catalog token overhead
  ✅ every gesture name satisfies host isSkillName
③ gesture injection render (provider.get + renderSkillContent, the pre-step path)
  ✅ full skill loads with content
  ✅ rendered injection opens <skill_content name="expert-backend-engineer">
  ✅ resourceBase is the parsed gesture directory (relative chain paths resolvable)
  ✅ injected body carries the T13 chain (project > global > bundled) + fail-closed
④ deployed declaration shape mounted AS PARSED: [root#1, root#2] → 13 skills
  ✅ 13 unique skills load (2 existing + 11 gestures) — got 13: 13 unique
  ✅ existing skills stay modelInvocable
  ✅ gestures stay modelInvocable:false in the combined mount
⑤ parent-root inertness: parsed root#1 alone still yields exactly the 2 pre-existing skills
  ✅ only expert-orchestration + trim-cli

PASS: gesture declaration (parsed from the shipped product) verified against /vol2/@appcenter/Harness/server/node_modules
（exit 0，2026-10-09 回炉后实跑）
```

### ② 旧宿主线 0.1.7-alpha.2（npm 公共注册表 pinned 包实装树；Q1 补留痕）

装树清单（S5 复现清单，2026-10-09 实执行，装树保留于 `/tmp/t14-host-0.1.7/` 供复查）：

```bash
rm -rf /tmp/t14-host-0.1.7 && mkdir -p /tmp/t14-host-0.1.7 && cd /tmp/t14-host-0.1.7
npm init -y
npm i --no-audit --no-fund \
  @deepseek-ai/dsh-skill-filesystem@0.1.7-alpha.2 \
  @deepseek-ai/dsh-skill@0.1.7-alpha.2 \
  @deepseek-ai/dsh-tool-skill@0.1.7-alpha.2
# 共 30 包（@deepseek-ai×25 + 顶层 5：@standard-schema/chokidar/readdirp/yaml/zod）
```

```
$ node scripts/verify-gesture-declaration.mjs /tmp/t14-host-0.1.7/node_modules
host modules: /tmp/t14-host-0.1.7/node_modules
declaration (parsed from cordis.patch.yml): customSkillDirs = [<scratch>/.agent-presets/expert-orchestrator/skills, <scratch>/.agent-presets/expert-orchestrator/skills/expert-gestures]
① parsed declaration shape … ✅ ×2（root#1/root#2 形态同 ①）
② gesture dir (parsed root#2) … ✅ ×4（11 candidates expert-backend-engineer … expert-tech-writer；modelInvocable:false ×11；目录过滤排除；isSkillName 通过）
③ gesture injection render … ✅ ×4（content / <skill_content name="expert-backend-engineer"> / resourceBase=parsed gesture dir / T13 链+fail-closed）
④ deployed declaration shape mounted AS PARSED … ✅ ×3（13 unique skills load — got 13: 13 unique；existing modelInvocable；gestures modelInvocable:false）
⑤ parent-root inertness … ✅ ×1（only expert-orchestration + trim-cli）

PASS: gesture declaration (parsed from the shipped product) verified against /tmp/t14-host-0.1.7/node_modules
（exit 0，2026-10-09 回炉后实跑；`dsh-skill-filesystem`/`dsh-skill` package.json version 实测 0.1.7-alpha.2）
```

初版曾声称旧代「同一脚本 12 项 PASS」但未留可复查现场（评审 Q1）；本节为回炉后补跑的完整现场：装树路径、命令、输出与 exit code 均在上，装树未删除，可逐字节复查。**首次执行即通过（非调参后复现）**。

v2.6 用户裁决 1B 先例原要求非当前宿主做静态核对；本记录在其之上加做了一档——旧代判定逻辑以发布物**真实执行**（按产物解析挂载），静态核对作为代码级证据保留于 §三。

## 三、静态核对（代码级；行号按两代实物逐条校准，2026-10-09 回炉 S4）

| 维度 | 0.1.7-alpha.2（npm pinned 实物 `/tmp/t14-host-0.1.7/node_modules`） | 0.2.1-alpha.1（参考 checkout 实物） |
| --- | --- | --- |
| 技能名规则 `SKILL_NAME` | `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`（dsh-skill lib/index.js:17） | 同（:17） |
| invocation frontmatter | `disable-model-invocation` / `user-invocable`；`modelInvocable`/`userInvocable`/`disableModelInvocation` 为被拒 legacy 键→整文件忽略+warn（skill-filesystem `parseInvocationPolicy` :849-859，legacy 拒收 :850-852，`rejectLegacyInvocationKey` throw :860-863） | 同（:849-859，:850-852，:860） |
| 缺省 invocation | modelInvocable=true、userInvocable=true | 同 |
| 手势正则 `SKILL_GESTURE` | `/(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g`（tool-skill :373） | 同（:1009） |
| 手势注入路径 | `agent/pre-step` 钩子（tool-skill :168 起）：`invokedSkillNames`(:171)→`skills.get`→`isUserInvocable`→`createUserMessage(renderSkillContent)`(:189-192) 合成 user 消息 | 同（:804 起；:807；:825-828） |
| 模型技能目录 | `snapshot.skills.filter(isModelInvocable)`——modelInvocable:false 不进目录（tool-skill :217） | 同（:853） |
| 模型侧 skill 工具 | 对非 modelInvocable 技能 `throw "skill … is not available for model invocation"`（tool-skill :147/150） | 同（:783/786） |
| 扫描形态 | `<dir>/SKILL.md` 或根下 `<name>.md`（flat）；`discoverRoot` 一层；缺 SKILL.md 静默跳过（skill-filesystem :587） | 同（:587） |
| `customSkillDirs` | `z.array(z.string()).default([])`（skill-filesystem :36）；root rank：project-dsh=100 < project-agents=200 < custom=300 < user-dsh=400 < user-agents=500 | 同（:36） |
| 同名裁决 | 同层 rank 升序、跨层「就近层整体胜出」，败者 `ignored because a higher-priority skill already exists` 告警（dsh-skill `collectLayer`/`collectFresh`） | 同 |

初版行号勘误（回炉 S4）：① pre-step 初版写 :171-190 / :807-826——实为钩子注册 :168 / :804 起（:171/:807 为 `invokedSkillNames` 行）；② `parseInvocationPolicy` 初版写 :849-857——实为 :849-859（两代同段，含 `};` 收尾）。其余行号经实物复核无漂移。评审建议值「0.1.7 parseInvocationPolicy 实为 :850-861」与本次实测（:849-859）差 1 行，以本表实测为准（方法：对 pinned/参考树 `lib/index.js` 逐条 grep/sed，见 §七）。

## 四、验收 (b) 机制论证：`/expert-名称` 注入零模型调用

1. 手势技能 frontmatter 带 `disable-model-invocation: true` → 宿主注册为 modelInvocable:false（两代实测 §二①②）。
2. 模型侧可见面：技能目录消息按 `isModelInvocable` 过滤——手势技能**不出现在任何模型提示中**（零目录 token）；模型经 skill 工具调用同名技能被宿主**拒绝**（两代 throw 文案见 §三）→ 不存在「模型自主决策触发注入」的通路。
3. 用户侧触发：用户消息中的 `/expert-<name>` token 命中 `SKILL_GESTURE` → 宿主 `agent/pre-step` 钩子在**同一步模型调用前**追加合成 user 消息（`renderSkillContent` 全文）——注入是宿主侧消息变换，不产生额外模型调用轮次；对照 summon_expert 通道（模型先决策调工具=1 次模型轮次，工具结果再注入），手势路径省去该决策轮次。
4. selftest 断言（test/tools.selftest.mjs T14 组，npm test 174/174）：手势文件必带 `disable-model-invocation: true` 且零 legacy 键（frontmatter 三键断言）+ 加载链文案断言 + **产物声明形态断言（回炉新增：解析 cordis.patch.yml 断言 skills 段在位）** + **部署面端到端断言（回炉新增：解析产物挂载→真实 FileSystemSkillProvider 注册 13）**——声明面一旦偏离即测试红。

## 五、命名冲突的确定性优先级

- 手势名恒为 `expert-<专家名>`（前缀使命名空间与 `expert-orchestration`/`trim-cli`/用户自建技能结构性隔离；selftest 断言不相交）。
- 万一同名（如用户项目层自建 `expert-backend-engineer` 技能），按宿主两态规则裁决（两代同构）：同层 rank 升序——项目 `.dsh/skills`=100 < 项目 `.agents/skills`=200 < 本 preset 手势（customSkillDirs）=300 < 全局 `~/.dsh/skills`=400 < `~/.agents/skills`=500；跨层就近层整体胜出；败者告警忽略（`ignored because a higher-priority skill already exists`）。**用户项目层同名技能确定性地优先于本 preset 手势**——用户定制胜出，且冲突告警可见、非静默遮蔽。
- 与 summon_expert 的关系（评审 S2 相关限定）：两者**name 精确匹配**语义同源（项目 > 全局 > 内置，命中即停）；summon 的 title 兜底不参与手势链（手势名固定，无需模糊解析）。

## 六、回炉记录（2026-10-09，评审报告 m1791480965012561）

### B1（阻断）：锚替换丢 `'skills'` 段 → 挂载根错位 → 部署面手势 0 个

- **缺陷**：`lib/expert-gestures.js` `deriveGestureDeclarationLine` 以 `", 'skills')"` → `", 'expert-gestures')"` 做锚**替换**，把挂载行末段 `'skills'` 替换掉了；产物 cordis.patch.yml:132 挂载根解析为 `<dst>/expert-gestures`，而部署器（lib/index.js `refreshEntry`，rel=`skills/expert-gestures`）落盘 `<dst>/skills/expert-gestures`——声明挂载的目录永不存在，宿主对缺失根 ENOENT 静默跳过（skill-filesystem :639-651），`/expert-<name>` 到达即死且无任何告警。
- **修复**：锚替换改为 `", 'skills')"` → `", 'skills', 'expert-gestures')"`（保留 skills 段、追加手势段）；派生守卫同步改为完整形态断言 `"', 'skills', 'expert-gestures')"`。重跑 `node scripts/gen-preset-declaration.mjs` 重生成产物：diff 实测**差量恰 cordis.patch.yml:132 一行**（`'expert-orchestrator', 'expert-gestures'` → `'expert-orchestrator', 'skills', 'expert-gestures'`），`skills/expert-gestures/` 11 文件逐字节不变（模板未动）。
- **复测（评审同款判别方法）**：① §二①② 两代 14/14 PASS、注册 13；② 鉴别力自证——回炉前产物快照（`/tmp/cordis.patch.yml.pre-t14-rework`）经 `parseGestureMount` 解析出 root#2 = `<home>/.agent-presets/expert-orchestrator/expert-gestures`（**无 skills 段**），新脚本 ①（形态）与 ④（挂载计数 2≠13）必红——缺陷不再能逃过验证面。

### B1-配套①：verify 脚本 ③ 产物化（12 项 → 14 项）

- 原检查③以仓库路径硬编码构造挂载（`[REPO/skills, REPO/skills/expert-gestures]`），从未解析实际产物——「deployed declaration shape」名不副实。**修复**：`lib/expert-gestures.js` 新增 `parseGestureMount(产物文本, DSH_HOME)`——提取 skill-filesystem 行 `customSkillDirs` 下两条 `!!js` 公式、按宿主同式求值（env 注入 DSH_HOME、node:path 用真实 `join`）；脚本全部检查改为挂载**解析产物所得目录**，并按部署器同款布局（`refreshEntry` 复制包内 skills/ 树到 `<dst>/skills/`）在私有 scratch 根模拟部署树。逐项过 12 项：原 ①②④⑤（现 ②③④⑤）的挂载目录全部改为解析产物所得；新增产物形态 2 项（现 ①）。硬编码源码事实的挂载面已归零。

### M1（重要）：测试自指盲区闭合

- 原用例 `deriveGestureDeclarationLine(生成器输出) === 生成器输出` 属自指断言，子串 `"', 'expert-gestures')"` 对正确/错误两形态通吃。**修复**（test/tools.selftest.mjs，172→174）：
  1. 可加性用例补完整形态断言 `"', 'skills', 'expert-gestures')"`；
  2. 新增「产物声明形态」用例——解析**提交的产物** cordis.patch.yml（而非生成器源码行为）：root#1 = `<DSH_HOME>/.agent-presets/expert-orchestrator/skills`、root#2 = root#1/`expert-gestures`、与手势文件落盘相对路径（`skills/expert-gestures`）对齐、旧缺陷形态负样本必须被解析判错；
  3. 新增「部署面端到端」用例——解析产物挂载 → 真实宿主 `FileSystemSkillProvider` 注册计数 = 13（11 手势 modelInvocable:false）；宿主模块不可用时 `t.skip`，与 verify 脚本 exit 2 同语义。
- 结果：npm test **174/174 全绿**（172 基线 + 2 新增）。

### 评审其余建议/疑问处置

| 项 | 处置 |
| --- | --- |
| S1 手势按文件名 `<name>.md` 指路 vs 文件层按 frontmatter name 匹配（文件名≠name 时 summon 可解析、手势找不到） | **代码不改**（超出本次回炉一行级：需改手势模板文案 + 11 文件重生成 + 测试连锁）；按评审给定的最低限度**在验证记录标注差异**：文件层专家文件名≠frontmatter name 的边缘场景下，手势走内置兜底（同名覆盖对手势不生效）；fail-closed 保证不产生错人注入，仅可能加载内置 persona 而非用户覆盖版 |
| S2 README「same semantics as summon_expert」措辞限定 | **不做**——README 不在本次回炉允许改动面；语义限定已在本记录 §五 第三条体现（name 精确匹配同源、title 兜底不参与手势链） |
| S3 花名册收缩后旧手势文件不剪枝（refreshEntry 只覆盖不删除） | **不做**——属 T16 版本工程对账剪枝议题；残留文件注入后因内置 persona 缺失走 fail-closed 显式失败，无静默错位 |
| S4 静态表行号 ±2~5 漂移 | **已做**——§三全表按两代实物校准并附初版勘误 |
| S5 旧代复现固化 | **以文档清单固化**——§二②装树命令 + 装树保留 `/tmp/t14-host-0.1.7/`；bootstrap 脚本文件超出本次允许改动面，不做 |
| Q1 旧代实跑无现场留痕 | **已闭合**——§二②补跑留完整现场（装树路径+命令+输出+exit 0，首次执行即通过） |
| Q2 未知手势 token（`/expert-nonexistent`）静默无回声 | 宿主行为非本 diff 范围，**不在本次处置**；留档提示：协议/SKILL.md 侧「失败无回声属正常」的用户提示归后续协议文案任务 |

## 七、复现命令

```bash
# 当前宿主（参考 checkout）
node scripts/verify-gesture-declaration.mjs
# 0.1.7-alpha.2 世代：先按 §二② 装树命令装树，然后
node scripts/verify-gesture-declaration.mjs /tmp/t14-host-0.1.7/node_modules
# 静态行号复核示例（两代同法，替换树根即可）
grep -n "function parseInvocationPolicy" <tree>/@deepseek-ai/dsh-skill-filesystem/lib/index.js
grep -n "SKILL_GESTURE = " <tree>/@deepseek-ai/dsh-tool-skill/lib/index.js
# 声明可复现（build 产物一致）+ 空输入幂等（空花名册=手势化前声明面）
node scripts/gen-preset-declaration.mjs --check
node scripts/gen-preset-declaration.mjs --empty-roster --check   # 需先 --empty-roster 生成态
npm test   # 174 pass（172 基线 + 2 新增 T14 回炉：产物声明形态、部署面 e2e）
```
