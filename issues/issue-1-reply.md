# Issue #1 回复稿（中文）

> 回复对象：[issue #1 — 目前不能给expert的专家指定模型，只能用主会话的模型](https://github.com/mario841859784/dsh-expert-orchestrator/issues/1)（@XSANElimos）
> 状态：草稿，待编排者审后发布。本稿对应 v2.14.0。

---

感谢反馈！这个问题在 v2.14.0 已经解决，而且比逐专家指定走得更远一步——现在支持三级 model 配置：**逐专家 → 领域分组 → 全局兜底**。下面把机制完整说明一下。

## 逐专家指定 model（v2.8 起已有，v2.14.0 补齐设置页与远程读写）

专家档案文件 `~/.dsh/expert-profiles.json`（全局层）与 `<当前工作目录>/.dsh/expert-profiles.json`（项目层，同名专家项目层覆盖全局层）中，给任意专家配置 `model` 字段即可：

```json
{
  "experts": {
    "后端工程师": { "model": "deepseek-chat" }
  }
}
```

每次 summon 现场读档案，**热改文件后新 summon 立即生效、恢复文件即回滚**，无需重启宿主。

## 领域分组 groups + 全局兜底 defaults（v2.14.0 新增）

不想逐个专家配的话，v2.14.0 新增了两个顶层键：

```json
{
  "experts": {
    "后端工程师": { "model": "deepseek-chat" }
  },
  "groups": {
    "前端组": {
      "model": "deepseek-v3",
      "members": ["前端开发者", "UI工程师"]
    },
    "重活组": {
      "members": ["后端工程师", "DevOps工程师"]
    }
  },
  "defaults": {
    "model": "deepseek-chat"
  }
}
```

**生效优先级链**（从高到低）：

1. **逐专家档案** `experts.<专家名>.model`
2. **领域组** — 该专家命中的组里，按声明顺序取**第一个声明了 model 的组**（若同时归入两个组且两组都声明了 model，取声明在前的那个，并在 stderr 出一行告警提醒检查配置；首个命中组没声明 model 则视为组层无值，继续往下落）
3. **defaults 兜底** `defaults.model`
4. **都未设置 = 主会话模型**（即你现在的行为）

**边界说明**：groups/defaults 本期仅承载 `model`，`tools`/`skills`/`mcp`/`effort` 仍只在逐专家层生效（组层留了扩展位，后续按需开放）。

## 不想手写 JSON？设置页有界面

v2.14.0 在宿主设置页新增了「**专家档案**」分区：

- **档案区**：逐专家编辑 `model`/`effort`，支持添加/删除条目（两步删除防误触）；
- **分组区**：建组、设组级 `model`、按成员归组（归组时会带来源徽标提示该专家来自哪个花名册来源）；按领域（division）预填建议；
- **defaults 兜底行**：设置全局默认 model；
- 每个专家旁有**生效来源徽标**（逐专家 / 组 / 兜底 / 主会话模型），当前 model 到底来自哪一级一眼可见。

设置页保存走原子写+滚动备份（`.bak`），保存后新 summon 即时生效。

## 一个前提

model 覆盖走子代理 agentOptions 通道，**provider 须声明 agentOptions 能力**——旧代宿主不支持时会有降级提示（不静默失效）。组层/defaults 层的 model 与逐专家层走同一能力预检，`effort` 同理有预检告警。

## 本期明确不做

- SKILL.md 任务书模板固定段与专家 persona 正文的翻译不在本期（协议面文本改动需要对照实验，避免影响既有编排行为）；
- `effort` 不进组层。

有问题欢迎继续反馈。
