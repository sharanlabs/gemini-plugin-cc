# Changelog

## 0.1.1 — 2026-10-14

- Replace ignored temporary system settings with a private per-job control workspace. Trust is established before Gemini loads settings; normal Google authentication stays in its original location.
- Confine native file writes with a per-task administrator policy and canonical-path safety checker. Every edit requires the verified macOS native-tool sandbox.
- Reject inherited extra directories and administrator/custom sandbox overrides that could widen the task boundary. An empty control environment file prevents inherited dotenv loading.
- Disable hooks, skills, extensions, MCP startup, IDE integration, and the local Gemma router through verified effective settings and CLI controls.
- Retain the control directory for session continuation, including handoff sessions; expose continuation through the guarded plugin. Older sessions without that directory require a fresh task.
- Refuse delegated shell execution after an independent reproduction of the upstream system temporary-directory write allowance. Claude runs project checks in the retained worktree.
- Add an explicit opt-in live provider smoke test using a synthetic repository, including review, isolated editing, continuation, and application. No provider request is made without `--run`.

Google sign-in and a live provider check are required to verify an account's model access. Automated component tests do not certify arbitrary model responses or every operating-system boundary.

## 0.1.0 — 2026-10-13

- Google-sign-in Gemini CLI companion with 14 namespaced skills and six specialist coordinators.
- Code review, adversarial review, acceptance judge, development advisor, investigation, isolated implementation, optional web tools and explicit model selection.
- Foreground/background jobs, cancellation, explicit session continuation and summary handoff.
- Incremental implementation patches with source-drift and conflict checks.
- Optional bounded completion review, disabled by default.
- Gemini CLI 0.63.0 compatibility contract, tested upstream policies and macOS per-tool sandbox opt-in.

This initial release has local automated and upstream-component validation. Live Google-authenticated model behavior remains an explicit smoke-test requirement. Windows and Linux shell delegation are unsupported.
