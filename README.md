<div align="center">

# DSH Expert Orchestrator

**PM-first planning · Agency-expert delegation · gated delivery · experience pooling**

A DeepSeek Harness (DSH) **agent preset plugin**: once installed, DSH gets an "Expert Orchestrator" session mode that never implements changes itself — it triages every request, has a project-management expert plan the work, delegates implementation to the best-fit domain experts, and gates delivery with independent review.

[中文文档](README.zh.md)

</div>

---

## How it works

- **Per-turn triage + five anchors** — every user message re-enters the loop (large task / small implementation / read-only); the five-anchor self-check runs before every action (review | converge | anti-drift | collaborate | resources) to prevent cross-turn drift.
- **PM first** — complex tasks go to a project-management expert (decomposition, dependencies, acceptance criteria) before any delegation.
- **Delegation only** — implementation is always delegated (Agency roster first, bundled expert-prompt library as fallback); the orchestrator only verifies read-only.
- **Taskboard + message bus** — two zero-dependency Python tools: a dependency-DAG task scheduler and a mailbox bus so parallel experts hand off full output on disk while replying with short summaries.
- **Delivery gate** — independent reviewer (≠ implementer, ≤2 rework rounds) then a PM checkpoint before any commit/delivery.
- **Experience pool** — ≤3 reusable lessons captured per task and injected into future task briefs.

## Install

```bash
dsh plugin --profile web add github:mario841859784/dsh-expert-orchestrator
```

or manually copy `agent.cordis.yml`, `preset.yml` and `skills/` into `~/.dsh/.agent-presets/expert-orchestrator/`, then restart DSH and pick the preset. Requires `python3`; the [dsh-agency-agents](https://github.com/MichengAI/dsh-agency-agents) roster plugin is optional (bundled fallback experts work without it). The bundled `trim-cli` skill's scripts wrapper and `bin` binary are not part of this package (excluded from the `files` whitelist); fetch them separately per the trim-cli skill docs.

The deployer never deletes anything in the target directory, refreshes protocol files only on version bumps, and treats `lessons.md` / `experts/*.md` as user data (add-only).

### Local source self-deploy (optional)

A market/plugin-manager install (`dsh plugin --profile web add github:mario841859784/dsh-expert-orchestrator`) mounts the deployer automatically via bundle patch — no manual composition entry is needed.

Only if you want to load the plugin from a local source checkout, patch the host layer instead (same mechanism as dsh-onebot): insert the following into `~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- insert:
    - id: expert-orchestrator-deploy
      name: '/absolute/path/to/dsh-expert-orchestrator/lib/index.js'
```

Upgrade semantics: when the plugin `VERSION` changes, the installed package content overwrites the PROTOCOL files (`agent.cordis.yml`, `preset.yml`, `skills/expert-orchestration/SKILL.md`, `skills/expert-orchestration/routing.md`, `skills/expert-orchestration/tools/taskboard.py`, `skills/expert-orchestration/tools/bus.py`, `skills/trim-cli/SKILL.md`, `skills/trim-cli/manifest.json`, `skills/trim-cli/entries`, `skills/trim-cli/reference` — 10 items in total); USER_DATA (`experts/`, `lessons.md`) is only created when missing. A host-layer local mount is not affected by that overwrite.

Migration note for existing installs: if you previously added an `expert-orchestrator-deploy` entry manually in `agent.cordis.yml`, migrate it to the host-layer `cordis.patch.yml` before upgrading — otherwise a VERSION-change refresh will overwrite that entry with the factory copy, silently breaking the local mount.

## Expert library & attribution

Shipped experts carry a `来源` (source) frontmatter field; the full catalog with per-expert sources lives in [EXPERTS.md](EXPERTS.md):

| Source | Count | Content |
|---|---|---|
| Self-authored | 11 | Chinese fallback experts shipped with the orchestration protocol |
| [VoltAgent/awesome-claude-code-subagents](https://github.com/VoltAgent/awesome-claude-code-subagents) (MIT) | 62 | Stack specialists: languages/frameworks, infrastructure, data & AI, quality/debugging, DX, vertical domains, architecture patterns |
| [wshobson/agents](https://github.com/wshobson/agents) (MIT) | 4 | Unique stacks: Julia, ARM Cortex embedded, NVIDIA DGX ops, LLM fine-tuning |
| [jnMetaCode/agency-agents-zh](https://github.com/jnMetaCode/agency-agents-zh) (MIT) | 1 | Chinese-ecosystem increment: search-growth orchestrator |

All upstream projects are MIT-licensed; expert texts remain copyrighted by their authors, redistribution here follows MIT with attribution.

## Credits

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [MichengAI/dsh-agency-agents](https://github.com/MichengAI/dsh-agency-agents) — the Agency expert roster
- [Asher-2000/dsh-expert-mode](https://github.com/Asher-2000/dsh-expert-mode) — inspiration for the five-anchor check, experience pool, independent review, taskboard and message bus
- [VoltAgent/awesome-claude-code-subagents](https://github.com/VoltAgent/awesome-claude-code-subagents) · [wshobson/agents](https://github.com/wshobson/agents) · [jnMetaCode/agency-agents-zh](https://github.com/jnMetaCode/agency-agents-zh) — imported expert library sources (MIT)

MIT © mario841859784
