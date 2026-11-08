# Issue #2 Reply draft (English)

> Target: [issue #2 — Add an option to choose the plugin's reply language](https://github.com/mario841859784/dsh-expert-orchestrator/issues/2) (@DarkHeros09)
> Status: draft, awaiting orchestrator review before publishing. Matches v2.14.0.

---

Thanks for the suggestion! v2.14.0 adds a **reply language option** with two switches:

## How to switch to English

**Option 1 — Settings page**: open the host settings page and set the plugin's `replyLanguage` option to `en`. The change takes effect on the next `summon` — no restart needed.

**Option 2 — Environment variable**: set `DSH_EXPERT_REPLY_LANG=en`. The env var takes precedence over the settings value (use `zh` to force Chinese back).

The default stays `zh`, so existing setups see zero behavior change. If the setting is missing or invalid, it falls back to `zh` rather than breaking.

## What it applies to

The option controls the language of **plugin-generated prompts and notices**, covering both:

- **Human-readable lines** — progress, budget, oscillation, checkpoint-resume, and effort-preflight hints injected into expert task briefs and results;
- **Model-readable protocol lines** — the structured instruction lines the plugin injects for the summoned agent.

Mechanical markers (`【…】` tags) and console prefixes stay untranslated so scripts and log-grepping keep working.

## What it intentionally does NOT cover (this release)

- **SKILL.md task-brief templates and expert persona bodies** are not translated in this release. These carry protocol-level text: translating them changes what the orchestrating and summoned agents read, and we only ship protocol-text changes after controlled experiments verify behavior is preserved. This is planned, not dropped.
- Expert-authored content (experience-pool entries, Python tool output) is out of scope.

## For developers

The strings live in a `zh`/`en` dictionary (`lib/messages.js`). The `zh` output is byte-for-byte identical to pre-2.14.0, so Chinese-language behavior is a strict no-op — the translation surface only activates when `en` is selected.

Feel free to follow up if the English coverage misses any line you run into.
