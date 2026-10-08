# Changelog

All notable changes to `dsh-expert-orchestrator`. Format loosely follows Keep a Changelog; versions are plugin semver (independent of the host `dsh` version, which is declared via `engines.dsh` / `peerDependencies`).

## [2.7.0] — 2026-10-09

### Added

- **WP-4b — crash-safe orchestration state (event sourcing)**
  - **Event-sourced taskboard** (T10, `taskboard.py`): the append-only event stream is the authority for board state — reads render a folded view over events, board files carry a dual-layer integrity hash, and a corrupted/truncated board replays deterministically from the event log instead of surfacing a silently empty task list.
  - **Bus cross-generation tri-state verdict + incremental reads + watchdog/adopt** (T11, `bus.py`/`taskboard.py`): bus reads filter by dispatch generation with an explicit three-state verdict (deliver / skip-round hint / archive), senders get monotone `seq` numbers so consumers can read incrementally (`--since-seq`), and a sliding-window watchdog detects silent `running` tasks — orphans with persisted completion evidence on the bus are adopted (attempt preserved) instead of being blindly reassigned.
  - **Summon resume (continuation)** (T12, `lib/tools.js`; new-generation hosts only — user ruling 2026-10-07 Q2=2A): on hosts exposing the continuation lifecycle the summon channel rebuilds an interrupted expert run as a durable continuable subagent and delivers exactly one resume turn whose prompt folds in breakpoint data (latest taskboard checkpoint + bus reports + partial pre-interrupt output); old-generation hosts keep the one-shot behavior unchanged, and `DSH_EXPERT_RESUME=0` force-disables the path. Protocol §3/§9 rewritten around it.
- **WP-5 — quality gates on the taskboard**
  - **Staged plan drafts** (T18): `taskboard.py create --draft` parks PM plans in a `draft` state — not claimable, not auto-promoted by dependency resolution — until an explicit `approve` flips them to `ready` (WP-5/S1 zero-spawn enforcement before approval). Protocol §2 gains the plan/draft/approve three-stage.
  - **Review kind** (T19): `create --kind review` marks acceptance subtasks; completion requires an explicit `--verdict` with `findings` hard-validation, a failed review auto-routes the task through repair and re-hangs downstream dependents, and an unresolvable review lands in the new `escalated` terminal state for user disposition.
  - **m-vote boolean consensus** (T20; user ruling Q3=3A — default m=3, review-round limit 2): `create --kind review --quorum-m [N]` convenes an N-reviewer jury; reviewers cast `taskboard.py vote <id> --by <name> --score <0..1>` (exactly 1 = pass, exactly 0 = fail, in-between = abstain; one vote per reviewer per round, re-votes rejected with a named error). A verdict takes effect only with ≥m same-direction votes **and zero reverse votes**; any reverse vote deadlocks → `escalated`. Every return-to-`ready` path (user retry, failed retry, watchdog reclaim, recover) resets the ballot so stale votes can never fake a quorum.
- **WP-6 — file-layer experts & zero-token gestures**
  - **Expert definition files** (T13, `lib/expert-files.js`; user ruling Q4=4A): experts resolve through a three-layer exact-name chain — project `<cwd>/.dsh/experts/<name>.md` > global `~/.dsh/experts/<name>.md` > bundled core (read-only fallback) — and file edits take effect immediately at summon time (runtime re-read, no restart).
  - **Zero-token expert gestures** (T14/T21): the 11 bundled core experts are additionally registered as `modelInvocable:false` host skills under `skills/expert-gestures/expert-<name>.md` (generated together with the preset declaration by `scripts/gen-preset-declaration.mjs`); typing `/expert-<name>` deterministically injects the persona via the host pre-step hook with zero model invocations and zero catalog token overhead. `scripts/verify-gesture-declaration.mjs` re-verifies the parsed declaration mount on any generation's host modules.
- **Protocol refresh drill (WP-8 ②, this release)**: simulated a VERSION bump (`2.6.0+sources1` → `2.7.0+sources1`) against a sandboxed `config.targetDir` through the real `apply()` path. All 14 PROTOCOL entries — including the new `skills/expert-gestures` directory (11 gesture files) — were overwritten byte-identical from the package; USER_DATA (`lessons.md`, `expert-lessons/`, `expert-methods/`) was only ever copy-if-missing (pre-seeded user content untouched, missing bundled files created); an extra non-core file inside the bundled `experts/` dir was migrated (not deleted) to `expert-sources/legacy-adapted/` per the documented upgrade semantics; the user `~/.dsh/experts` file layer outside the deploy tree was untouched. Extends the v2.6.0 drill (13 items, no gesture dir) with the v2.7 command/dir surface; real deploy directories were not modified during the drill.

### Changed

- **PROTOCOL refresh manifest gains `skills/expert-gestures`** — the version-marker refresh now covers 14 entries. (The README upgrade-semantics paragraph counts "11 items": it omits `source-registry.json`, `roster-aliases.json`, and `skills/expert-orchestration/experts/`, which are listed separately and also refreshed.)
- **engines/peer — no change for 2.7.0**: `engines.dsh` and the `@deepseek-ai/dsh-tools` peer range already carry the `>=0.2.1-0 <0.3.0-0` branch since 2.6.0; re-verified via a static semver membership matrix (9/9 rows: `0.1.7-alpha.2` and `0.2.1-alpha.1` both hit; `0.2.2-alpha.x` correctly does not — each 0.2.x patch prerelease line still needs its own branch appended, as noted in 2.6.0).
- `lib/index.js` deploy marker `VERSION` literal synced to 2.7.0 (drives the PROTOCOL whole-directory refresh via `.deployed-version`); `package.json` and `dsh.plugin.json` bumped in lockstep.

### Fixed

- `npm pack` no longer emits `skills/expert-orchestration/tools/__pycache__/` byte-code caches (a tools-dir `.npmignore` added post-2.6.0); the 2.7.0 tarball holds 78 files matching the `files` whitelist with no `docs/`, `test/`, `scripts/`, or repo-state leakage.

### Verified / not verified this release (user ruling 1B)

- Static-declaration checks were re-run for both host generations: the semver membership matrix above, the refresh drill, the npm pack audit, and the tool return-value scan (no explicit `undefined` reaches any tool JSON return face; 8 internal/fail-open `undefined`/`None` returns documented as exempt). `npm test` green.
- The two-generation **live** verification for the v2.7 gesture surface is recorded in `docs/internal/verification/T14-two-generation-declaration.md` (T14): the parsed product declaration mounted against real host code of both `0.2.1-alpha.1` and `0.1.7-alpha.2` — 14/14 checks on each, 13 skills registered (2 existing + 11 gestures), gestures excluded from the model catalog. Summon resume stays new-generation-gated by design (Q2=2A); the running host remains `0.2.1-alpha.1` — end-to-end checks that require a host restart are deferred until the user restarts (「待用户重启后补测」).

## [2.6.0] — 2026-10-08

### Added

- **WP-1 — taskboard concurrency correctness** (`taskboard.py`): CAS `expected_revision` optimistic locking on every write (stale revision returns a named error and never touches the file); attempt generations (reassignment revokes the old attempt, done/report from a stale attempt id are rejected); explicit `unrecoverable` error objects on corrupted board files (never a silently empty task list); full dependency-graph cycle detection before dependency writes.
- **WP-2 — message-bus delivery semantics** (`bus.py`): at-least-once delivery (the cursor advances only after a success receipt); reads filter by the current attempt generation and archive expired messages instead of exposing them in the inbox; explicit skip-round hint when the inbox contains only expired messages; atomic writes throughout.
- **WP-3 — enforcement plane** (opt-in): a zero-dependency `commit-msg` hook template with triple check (message format + task existence + file scope), installed into the user repo's `.git/hooks/` only on explicit request; verification receipts are bound to per-file SHA-256 scope fingerprints — any file change after a receipt marks it stale/invalid.
- **WP-4a — auto-claim on dispatch** (`summon_expert`): task ids parsed from summon briefs are claimed automatically (in_progress + owner) before the expert runs; fail-open with a visible hint, never blocks dispatch.
- **WP-8a — host settings migration**: the plugin's user-facing configuration is registered on the host schemastery namespace (插件配置 page); every settings write carries `expectedRevision` optimistic concurrency and returns a named error on conflict. All settings registration is fail-open — bare checkouts and degraded builds still load the plugin.
- **Protocol refresh drill (WP-8 ②, this release)**: simulated a VERSION bump against a sandboxed `config.targetDir` and verified that all PROTOCOL entries (13 items, including `SKILL.md`, `taskboard.py`, `bus.py` — all touched by this iteration) are overwritten wholesale by `refreshEntry`, while user data (`lessons.md`, `expert-lessons/`, `expert-methods/`) is only ever `copyIfMissing` and is not touched. Real deploy directories were not modified during the drill.

### Changed

- **peer/engines — 0.2.1-alpha host line**: `engines.dsh` and the `@deepseek-ai/dsh-tools` peer range gain the branch `>=0.2.1-0 <0.3.0-0`. Under strict semver, a prerelease version only satisfies a range when a comparator carries a prerelease on the same `[major, minor, patch]` tuple — `0.2.1-alpha.1` does **not** match `>=0.2.0-rc.1 <0.3.0-0` (tuple `(0,2,1)` ≠ `(0,2,0)`). Note for future 0.2.x patch prerelease lines (e.g. `0.2.2-alpha.x`): each line needs its own branch appended.
- `lib/index.js` deploy marker `VERSION` literal synced to the release version (it drives the PROTOCOL whole-directory refresh via `.deployed-version`).

### Verified / not verified this release (user ruling 1B)

- The running host is `0.2.1-alpha.1`; per the user's 1B ruling, host-level testing this release covers the **current host only** (`0.2.1-alpha.1`) — hot-mountable and static-declaration checks only (`npm pack` integrity, semver range membership, PROTOCOL refresh drill). The `0.1.7-alpha.2` line is **not re-tested this round**; its peer branches are kept, compatibility rests on static analysis, and end-to-end verification that requires a host restart is explicitly deferred (「待用户重启后补测」).

## [2.5.4] — 2026-10-07

- `c1ed945`: declare `engines.dsh` 0.2.0-rc branch (`>=0.2.0-rc.1 <0.3.0-0`), widen the `dsh-tools` peer range, sync `dsh.plugin.json` version.

## [2.5.3] — 2026-10-06

- `618e25f`: bilingual description, npm keywords, README synonyms.

## [2.5.2] — 2026-10-05

- `4202398`: explicit prerelease branches so `0.1.7-alpha` hosts resolve.

## [2.5.1] — 2026-10-04

- `975850e`: declare `engines.dsh >=0.1.7-alpha.2`, widen `dsh-tools` peer.

## [2.5.0] — 2026-10-03

- Preset declared via bundle patch row (`preset-<id>` in `cordis.patch.yml`) for DSH >= 0.1.7-alpha; source management runtime (T2): per-source install/enable/merge view, security scan with ackScan, legacy migration; protocol files refresh only on deploy-marker change.
