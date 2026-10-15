# Changelog

## 0.2.1 — 2026-10-15

- Prevent delegated requests from opening browser consent or treating task input as a sign-in answer when cached Google authentication is unavailable.
- Report the pinned CLI authentication failure with clear steps to finish interactive sign-in; keep malformed structured output rejected.
- Clarify that browser sign-in must return to the Gemini chat prompt before exiting.

## 0.2.0 — 2026-10-15

- Add Windows review, advice, judgment, investigation, implementation, jobs and continuation. Windows edits use bounded validated proposals in owned task worktrees.
- Add downloadable macOS and Windows installers with verified private Node bootstrap, pinned Gemini CLI, stable launch/sign-in shortcuts, rerun support and version checks.
- Protect Windows state with private DACLs, launch npm entry points through Node, and cancel owned process trees.
- Preserve exact source line endings, tracked executable modes, staged changes and baseline files hidden by new ignore rules.
- Package only immutable committed source, reject tracked sensitive paths, and publish checksums.
- Simplify installation and usage documentation and add real Windows, upstream and installer CI.

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
