<div align="center">

# DSH Expert Orchestrator

**PM-first planning · merged-roster delegation · gated delivery · experience pooling**

A DeepSeek Harness (DSH) **agent preset plugin**: once installed, DSH gets an "Expert Orchestrator" session mode that never implements changes itself — it triages every request, has a project-management expert plan the work, delegates implementation to the best-fit domain experts, and gates delivery with independent review.

[中文文档](README.zh.md)

</div>

---

## How it works

- **Per-turn triage + five anchors** — every user message re-enters the loop (large task / small implementation / read-only); the five-anchor self-check runs before every action (review | converge | anti-drift | collaborate | resources) to prevent cross-turn drift.
- **PM first** — complex tasks go to a project-management expert (decomposition, dependencies, acceptance criteria) before any delegation.
- **Delegation only** — implementation is always delegated (merged expert roster first — bundled core + enabled sources — with the bundled expert-prompt library as fallback); the orchestrator only verifies read-only.
- **Taskboard + message bus** — two zero-dependency Python tools: a dependency-DAG task scheduler and a mailbox bus so parallel experts hand off full output on disk while replying with short summaries.
- **Delivery gate** — independent reviewer (≠ implementer, ≤2 rework rounds) then a PM checkpoint before any commit/delivery.
- **Experience pool** — ≤3 reusable lessons captured per task and injected into future task briefs.

## Install

```bash
dsh plugin --profile web add github:mario841859784/dsh-expert-orchestrator
```

or manually copy `agent.cordis.yml`, `preset.yml` and `skills/` into `~/.dsh/.agent-presets/expert-orchestrator/`, then restart DSH and pick the preset. Requires `python3`; the [dsh-agency-agents](https://github.com/MichengAI/dsh-agency-agents) roster plugin is **optional coexistence, not a dependency** — this plugin no longer depends on it: the merged-roster protocol works fully without it, and when it is installed its roster is treated as just an additional source. The bundled `trim-cli` skill's scripts wrapper and `bin` binary are not part of this package (excluded from the `files` whitelist); fetch them separately per the trim-cli skill docs.

After install, only the **11 bundled core experts** ship in `skills/expert-orchestration/experts/`. The four upstream expert source packs are **not** bundled — download and enable them from the plugin's settings page (**Expert sources**): the host runtime fetches via the GitHub direct or CDN mirror channels and verifies sha256 (pinned archive hashes) before unpacking anything. Install-time security scans (credential-leak + prompt-injection patterns) are tiered by origin: for **registry sources** (sha256-pinned), a scan hit raises a warning and proceeds only after explicit user confirmation — never auto-rejection; **custom/local-path sources** outside the registry are hard-rejected on a hit; symlinks are always skipped and logged, never a rejection on their own.

The deployer never deletes anything in the target directory, refreshes protocol files only on version bumps, and treats `lessons.md` and `expert-sources/` (downloaded source packs + merged roster view) as user data (add-only).

### Local source self-deploy (optional)

A market/plugin-manager install (`dsh plugin --profile web add github:mario841859784/dsh-expert-orchestrator`) mounts the deployer automatically via bundle patch — no manual composition entry is needed.

Only if you want to load the plugin from a local source checkout, patch the host layer instead (same mechanism as dsh-onebot): insert the following into `~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- insert:
    - id: expert-orchestrator-deploy
      name: '/absolute/path/to/dsh-expert-orchestrator/lib/index.js'
```

Upgrade semantics: when the plugin `VERSION` changes, the installed package content overwrites the PROTOCOL files (`agent.cordis.yml`, `preset.yml`, `skills/expert-orchestration/SKILL.md`, `skills/expert-orchestration/routing.md`, `skills/expert-orchestration/tools/taskboard.py`, `skills/expert-orchestration/tools/bus.py`, `skills/trim-cli/SKILL.md`, `skills/trim-cli/manifest.json`, `skills/trim-cli/entries`, `skills/trim-cli/reference` — 10 items in total), plus `skills/expert-orchestration/experts/` which now ships only the 11 bundled core experts (PROTOCOL refresh). USER_DATA (`lessons.md`, `expert-sources/` — downloaded source packs and the merged roster) is only created when missing and never overwritten; on first run after this version, previously adapted expert copies are migrated once into `expert-sources/legacy-adapted/` (frozen local source, enabled by default) instead of being deleted. A host-layer local mount is not affected by that overwrite.

Migration note for existing installs: if you previously added an `expert-orchestrator-deploy` entry manually in `agent.cordis.yml`, migrate it to the host-layer `cordis.patch.yml` before upgrading — otherwise a VERSION-change refresh will overwrite that entry with the factory copy, silently breaking the local mount.

## Expert source projects

Expert content beyond the 11 bundled core experts comes from four MIT-licensed upstream projects. All four are registered in `skills/expert-orchestration/source-registry.json` and referenced **verbatim — file names and contents unchanged** (files are unpacked as-is; attribution lives in [NOTICE](NOTICE)):

| Project | License | Adoption in this plugin | Pinned files |
|---|---|---|---|
| [VoltAgent/awesome-claude-code-subagents](https://github.com/VoltAgent/awesome-claude-code-subagents) | MIT | **Classic pack content source** — anchors the previously adapted expert copies in the offline classic pack (62 files) | 171 (`categories/**/*.md`) |
| [wshobson/agents](https://github.com/wshobson/agents) | MIT | **Classic pack content source** — anchors the previously adapted expert copies in the offline classic pack (4 files) | 202 (`plugins/*/agents/*.md`) |
| [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents) | MIT | **Standalone source pack** — installed whole as an independent source | 274 (`*/*.md`) |
| [jnMetaCode/agency-agents-zh](https://github.com/jnMetaCode/agency-agents-zh) | MIT | **Standalone source pack** — installed whole as an independent source | 273 (`*/*.md`) |

Counts are the unpacked file numbers actually selected at each pinned ref after applying the registry `include`/`exclude` patterns (verified against the pinned archives' sha256).

The first two are the content sources of the classic pack (the offline fallback release anchoring the 67 previously adapted expert copies); the latter two ship as independent source packs. Downloads go through the GitHub direct or CDN mirror channels with sha256 verification and tiered install-time security scanning (tiering rules see the deployment section above); installed sources appear in the merged expert roster as `source-name / original-name`, and cross-source duplicate names coexist with explicit source labels. All upstream projects are MIT-licensed; expert texts remain copyrighted by their authors, redistribution here follows MIT with attribution.

**Recommended configuration (Chinese-language users):** enable **awesome-claude-code-subagents + agency-agents-zh** as the source set — together with the 11 bundled core experts they cover the common routing table entries with Chinese-native expert texts; add the other sources only when you need them. **Decoupling statement:** this plugin no longer depends on `dsh-agency-agents` — the merged expert roster (bundled core + enabled sources) is the primary supply for expert selection; the protocol is fully usable with `dsh-agency-agents` uninstalled, and when it is installed its roster counts as an additional source the protocol does not require.

## Credits

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [MichengAI/dsh-agency-agents](https://github.com/MichengAI/dsh-agency-agents) — optional Agency expert roster (coexistence supported, not a dependency)
- [Asher-2000/dsh-expert-mode](https://github.com/Asher-2000/dsh-expert-mode) — inspiration for the five-anchor check, experience pool, independent review, taskboard and message bus
- [VoltAgent/awesome-claude-code-subagents](https://github.com/VoltAgent/awesome-claude-code-subagents) · [wshobson/agents](https://github.com/wshobson/agents) · [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents) · [jnMetaCode/agency-agents-zh](https://github.com/jnMetaCode/agency-agents-zh) — imported expert library sources (MIT)

MIT © mario841859784
