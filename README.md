<div align="center">

# DSH Expert Orchestrator

**Multi-agent orchestration · PM-first planning · merged-roster expert delegation · dependency-DAG taskboard · gated delivery · experience pooling**

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
- **Native expert tools** — `list_experts` (browse the merged roster, compact/expanded modes), `summon_expert` (single white-paper summon: persona injected via sanitizePersona, resolution exact → aliases → unambiguous title, shadowed/disabled rejected, 8K-char task cap), and `summon_experts` (batch ≤8, concurrency 4, partial-success semantics). Recursion protection: spawned sub-agents get a six-entry `toolFilter` deny list (no expert-tool re-summoning, no `subagent`/`subagent_fork` nesting, no `workflow`) with the tool schema default depth 3 as a backstop — one level of delegation, no runaway expert trees.
- **Per-expert lesson pool & persona method layering (v2.4.0)** — summon auto-appends a per-expert lesson hint (≤2000 chars, character-level truncation) from `expert-lessons/<slug>.md`; persona frontmatter `method:` + `<!-- methods-cut -->` split injects a slim persona with an on-demand deep-read pointer (top-5 bundled-core experts layered, fail-safe full-text fallback; gated by a pre-registered A/B experiment, archive in `docs/internal/experiments/`); `list_experts` marks cross-source conflicts/shadowed entries explicitly, and custom-expert deletions support cleanup. Known limitations: the settings-panel "purge deleted" button UI is pending (RPC contract in place).

## What's new in v2.7

- **Crash-safe orchestration state (WP-4b)** — the taskboard is event-sourced (append-only event stream as authority, dual-layer integrity hashes, deterministic crash replay); the bus filters by dispatch generation with a tri-state verdict and supports incremental reads (`--since-seq`); a watchdog adopts orphaned experts when their completion evidence is already on the bus. `summon_expert` can resume interrupted expert runs as durable continuations on new-generation hosts (ruling Q2=2A — old hosts keep one-shot behavior; `DSH_EXPERT_RESUME=0` disables).
- **Quality gates (WP-5)** — PM plans stage as `draft` until approved (`create --draft` / `approve`); `--kind review` subtasks require explicit verdicts with findings validation, auto-repair routing, and an `escalated` terminal state; multi-reviewer tasks (`--quorum-m`, default 3, ruling Q3=3A) reach a verdict only with ≥m same-direction votes and zero reverse votes, with ballot resets on every return-to-`ready` path.
- **File-layer experts & zero-token gestures (WP-6)** — expert personas resolve through project > global > bundled `.md` file layers (ruling Q4=4A) with runtime re-read; `/expert-<name>` gestures inject the 11 core experts with zero model invocations (see the section below).

## What's new in v2.6

- **Concurrency-safe taskboard** — every write carries `expected_revision` (CAS optimistic locking; a stale revision returns a named error and never touches the board); task attempt generations reject done/report from revoked attempts; corrupted board files return an explicit `unrecoverable` error instead of a silently empty list; dependency cycles are rejected before write.
- **At-least-once message bus** — the bus cursor advances only after a success receipt (a crash mid-delivery re-delivers); messages from revoked attempts are archived on read, never shown in the inbox; an inbox with only expired messages returns an explicit skip-round hint.
- **Opt-in enforcement plane** — a zero-dependency `commit-msg` hook (message format + task existence + file scope) installs into your repo only on explicit request; verification receipts bind per-file SHA-256 scope fingerprints, so any file change after a receipt invalidates it.
- **Auto-claim on dispatch** — `summon_expert` claims task ids parsed from the summon brief (in_progress + owner) before the expert runs; fail-open with a visible hint.
- **Host settings page** — plugin configuration moved onto the host schemastery namespace (插件配置 page) with `expectedRevision` optimistic concurrency on every write; registration is fail-open and never blocks plugin load.

## Install

```bash
dsh plugin --profile web add github:mario841859784/dsh-expert-orchestrator
```

### Let an agent install it for you

Paste this into any DSH chat (the orchestrator preset itself is not required):

```text
Please install the dsh-expert-orchestrator plugin for me: run
`dsh plugin --profile web add github:mario841859784/dsh-expert-orchestrator`,
then remind me to restart DSH and pick "专家编排模式 / Expert Orchestrator"
from the session preset picker.
```

or manually copy the package into a bundle location and restart DSH, then pick **专家编排模式 / Expert Orchestrator** from the session preset picker. Requires `python3`; the [dsh-agency-agents](https://github.com/MichengAI/dsh-agency-agents) roster plugin is **optional coexistence, not a dependency** — this plugin no longer depends on it: the merged-roster protocol works fully without it, and when it is installed its roster is treated as just an additional source. The bundled `trim-cli` skill's scripts wrapper and `bin` binary are not part of this package (excluded from the `files` whitelist); fetch them separately per the trim-cli skill docs.

### How the preset is registered (v2.5.0+)

**DSH compatibility (v2.6.0+): `engines.dsh >=0.1.7-alpha.2 <0.2.0-0 || >=0.2.0-rc.1 <0.3.0-0 || >=0.2.1-0 <0.3.0-0`** — the declaration-row preset mechanism is verified against DSH 0.1.7-alpha.2 and adapted to DSH 0.2.0-rc.1; the 0.2.1-alpha branch was added for the current host line (`0.2.1-alpha.1`) because strict semver never matches a prerelease against a comparator on a different `[major, minor, patch]` tuple. `@deepseek-ai/dsh-tools` peer accepts `>=0.1.6-alpha.1 <0.1.7-0 || >=0.1.7-alpha.2 <0.2.0-0 || >=0.2.0-rc.1 <0.3.0-0 || >=0.2.1-0 <0.3.0-0`. Verification scope (user ruling 1B, v2.6.0): only the running host `0.2.1-alpha.1` was exercised this release, via hot-mountable and static-declaration checks; the `0.1.7-alpha.2` line was **not re-tested this round** — its peer branches are kept and compatibility rests on static analysis; end-to-end checks that require a host restart are deferred until the user restarts.

Since DSH **0.1.7-alpha**, agent presets are **declaration rows carried by bundle patches** — a `preset-<id>` row named `@deepseek-ai/dsh-agent-preset` whose `config.plugins` holds the full Cordis entry list. The legacy `~/.dsh/.agent-presets/<id>/` directory (`preset.yml` + `agent.cordis.yml`) is **no longer read by anything**: a preset deployed only as that directory never appears in the preset picker. This plugin therefore declares the preset inline in its own bundle patch (`cordis.patch.yml`, row `preset-expert-orchestrator`), so a normal plugin install is sufficient — installing the bundle, restarting DSH, and the preset shows up in the session mode picker. The deployed `~/.dsh/.agent-presets/expert-orchestrator/` directory remains the preset's **runtime data root** (skills, experts, lessons, expert sources); the declaration's `skill-filesystem` row resolves it with the same `DSH_HOME || ~/.dsh` formula the deployer uses.

After install, only the **11 bundled core experts** ship in `skills/expert-orchestration/experts/`. The four upstream expert source packs are **not** bundled — download and enable them from the plugin's settings page (**Expert sources**): the host runtime fetches via the GitHub direct or CDN mirror channels and verifies sha256 (pinned archive hashes) before unpacking anything. Install-time security scans (credential-leak + prompt-injection patterns) are tiered by origin: for **registry sources** (sha256-pinned), a scan hit raises a warning and proceeds only after explicit user confirmation — never auto-rejection; **custom/local-path sources** outside the registry are hard-rejected on a hit; symlinks are always skipped and logged, never a rejection on their own.

Expert management is per-expert: any single expert inside an installed source can be disabled individually (files stay, re-enable anytime), and the settings page lets you create/edit/soft-delete up to **200 custom experts** — custom experts rank just below bundled-core and take precedence over source-pack duplicates when chosen as the dedup representative; built-in and source-pack experts are read-only references (copy to a custom expert to modify); custom prompts are user-written, skip third-party source scanning, and are subject to length limits.

The deployer never deletes anything in the target directory, refreshes protocol files only on version bumps, and treats `lessons.md` and `expert-sources/` (downloaded source packs + merged roster view) as user data (add-only).

### Zero-token expert gestures (v2.7): /expert-<name>

The 11 bundled core experts are registered as **modelInvocable:false host skills** (`skills/expert-gestures/expert-<name>.md`, generated from the bundled-core roster together with the preset declaration by `scripts/gen-preset-declaration.mjs`). Type `/expert-<name>` directly in your message (e.g. `/expert-backend-engineer`, `/expert-tech-writer`) and the host pre-step hook **deterministically injects** the matching gesture skill — zero model invocations, no model decision step (such skills never appear in the model skill catalog, and the model cannot invoke them through the skill tool, so they add no catalog token overhead).

After the injection, the persona is still resolved live through the file-layer-first chain: **project `<cwd>/.dsh/experts/<name>.md` > global `~/.dsh/experts/<name>.md` > bundled `skills/expert-orchestration/experts/<name>.md`** (exact name match only, same semantics as summon_expert; file edits take effect immediately). If none of the three layers matches, the gesture fails loudly instead of improvising an expert from memory.

Scope and conflict resolution: the gesture **covers only the stable roster** — file-layer experts (freely created/edited) and source-pack experts (managed per source) are never registered. Name conflicts with existing skills are resolved deterministically by the host (within a layer, ascending rank: project `.dsh/skills`=100 < project `.agents/skills`=200 < this preset's gestures=300 < global `~/.dsh/skills`=400 < `~/.agents/skills`=500; across layers the nearest layer wins outright; losers are dropped with a warning) — a user's project-level skill with the same name deterministically outranks the gesture. The skill declaration-line format and gesture mechanics are verified dimension-by-dimension on both host generations (0.1.7-alpha.2 and 0.2.x; see `docs/internal/verification/`); for an already-deployed preset the gesture layer activates at the next VERSION-marker refresh (restart-level items are flagged as "pending user restart re-test" in that record).

### Local source self-deploy (optional)

A market/plugin-manager install (`dsh plugin --profile web add github:mario841859784/dsh-expert-orchestrator`) mounts the deployer automatically via bundle patch — no manual composition entry is needed.

Only if you want to load the plugin from a local source checkout, patch the host layer instead (same mechanism as dsh-onebot): insert the following into `~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- insert:
    - id: expert-orchestrator-deploy
      name: '/absolute/path/to/dsh-expert-orchestrator/lib/index.js'
```

Upgrade semantics: when the plugin `VERSION` changes, the installed package content overwrites the PROTOCOL files (`agent.cordis.yml`, `preset.yml`, `skills/expert-orchestration/SKILL.md`, `skills/expert-orchestration/routing.md`, `skills/expert-orchestration/tools/taskboard.py`, `skills/expert-orchestration/tools/bus.py`, `skills/trim-cli/SKILL.md`, `skills/trim-cli/manifest.json`, `skills/trim-cli/entries`, `skills/trim-cli/reference`, `skills/expert-gestures`), plus `skills/expert-orchestration/experts/` which now ships only the 11 bundled core experts, plus `skills/expert-orchestration/source-registry.json` and `skills/expert-orchestration/roster-aliases.json` — 14 items in total (PROTOCOL refresh). USER_DATA (`lessons.md`, `expert-sources/` — downloaded source packs and the merged roster) is only created when missing and never overwritten; on first run after this version, previously adapted expert copies are migrated once into `expert-sources/legacy-adapted/` (frozen local source, enabled by default) instead of being deleted. A host-layer local mount is not affected by that overwrite.

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
