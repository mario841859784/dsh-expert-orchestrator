# Changelog

All notable changes to `dsh-expert-orchestrator`. Format loosely follows Keep a Changelog; versions are plugin semver (independent of the host `dsh` version, which is declared via `engines.dsh` / `peerDependencies`).

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
