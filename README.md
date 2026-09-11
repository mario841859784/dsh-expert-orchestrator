<div align="center">

# DSH Expert Orchestrator

**PM-first planning · Agency-expert delegation · gated delivery · experience pooling**

A DeepSeek Harness (DSH) **agent preset plugin**: once installed, DSH gets an "Expert Orchestrator" session mode that never implements changes itself — it triages every request, has a project-management expert plan the work, delegates implementation to the best-fit domain experts, and gates delivery with independent review.

[中文文档](README.zh.md)

</div>

---

## How it works

- **Per-turn triage + five anchors** — every user message re-enters the loop (large task / small implementation / read-only); five explicit self-checks prevent cross-turn drift.
- **PM first** — complex tasks go to a project-management expert (decomposition, dependencies, acceptance criteria) before any delegation.
- **Delegation only** — implementation is always delegated (Agency roster of 321 experts first, bundled expert-prompt library as fallback); the orchestrator only verifies read-only.
- **Taskboard + message bus** — two zero-dependency Python tools: a dependency-DAG task scheduler and a mailbox bus so parallel experts hand off full output on disk while replying with short summaries.
- **Delivery gate** — independent reviewer (≠ implementer, ≤2 rework rounds) then a PM checkpoint before any commit/delivery.
- **Experience pool** — ≤3 reusable lessons captured per task and injected into future task briefs.

## Install

```bash
dsh plugin --profile web add github:mario841859784/dsh-expert-orchestrator
```

or manually copy `agent.cordis.yml`, `preset.yml` and `skills/` into `~/.dsh/.agent-presets/expert-orchestrator/`, then restart DSH and pick the preset. Requires `python3`; the [dsh-agency-agents](https://github.com/MichengAI/dsh-agency-agents) roster plugin is optional (bundled fallback experts work without it).

The deployer never deletes anything in the target directory, refreshes protocol files only on version bumps, and treats `lessons.md` / `experts/*.md` as user data (add-only).

## Credits

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [MichengAI/dsh-agency-agents](https://github.com/MichengAI/dsh-agency-agents) — the Agency expert roster
- [Asher-2000/dsh-expert-mode](https://github.com/Asher-2000/dsh-expert-mode) — inspiration for the five-anchor check, experience pool, independent review, taskboard and message bus

MIT © mario841859784
