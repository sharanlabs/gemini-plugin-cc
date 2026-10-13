# Gemini companion implementation plan

**Goal:** An unofficial Claude Code plugin using the installed Gemini CLI with Google sign-in as an independent specialist for review, adversarial review, investigation and implementation.

**Architecture:** Namespaced skills and Claude routing agents call a dependency-free Node companion. A version-checked Gemini adapter forces Google OAuth and restricted tools; an atomic private job store manages foreground/background work. Implementation runs in retained detached Git worktrees and produces incremental patches that are checked before applying to the source checkout.

**Evidence:** OpenAI codex-plugin-cc workflow; Anthropic plugin/skill/agent/hook documentation; Google Gemini CLI authentication, headless, policy and pinned source. URLs are in README and SECURITY.

**Decisions:** Wrap Gemini CLI instead of owning API credentials or emulating Claude's model protocol. Match workflows without claiming unsupported native transcript import. Keep Google authentication with the CLI. No automatic model fallback. No unattended review loops. A linked worktree isolates changes, but is not an OS security sandbox.

## Tasks and acceptance

- [x] Runtime: pin and probe supported CLI; stream result, usage, model and session; force Google OAuth; disable extensions/MCP/hooks; test timeout, output limit, abort, malformed output, denied tool discovery and auth selectors.
- [x] Git context: test real repositories with staged/unstaged/untracked changes and branch merge-base; bound and filter context; snapshot dirty source into a detached task worktree without changing source.
- [x] Jobs: test atomic private storage, workspace isolation, request validation, lifecycle, cancellation and expired workers. Background processes persist independently of Claude's Bash timeout.
- [x] Integration: test independent reviewer/adversarial/investigator/implementer prompts, session continuation, context handoff, implementation snapshot and guarded patch apply. Reject source drift and conflicting operations.
- [x] Packaging: marketplace, manifest, namespaced skills, independent specialist routers, CI, user/security docs. Verify with the installed Claude plugin validator.
- [x] Optional review gate: explicit enable only; one completed review per transcript stop and no recursive loop; usage is user initiated; off by default.
- [x] Final validation: all Node tests, syntax checks, Claude manifest validation, full fake-CLI smoke flow, artifact packaging and independent review. Live Google OAuth/model access requires a locally authenticated supported Gemini CLI and remains unverified because no cached Google sign-in exists on this machine. See validation.md.

## Boundaries

Never install globally, alter existing Claude/Gemini settings, authenticate, publish or run paid/quotad model calls as part of build validation. No secrets are requested/read by this plugin. Repository content sent to Google remains subject to the CLI/account terms; pattern filtering cannot detect every secret. Generated job data stays private and is never committed.
