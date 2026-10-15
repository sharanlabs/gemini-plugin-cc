# Cross-platform installation and execution

Goal: let a developer install Gemini Companion on macOS or Windows, sign in with Google, and delegate independent review, advice, judgment, investigation, and implementation from Claude Code.

## Decisions

- Keep the verified macOS native file-tool sandbox. On Windows, expose read tools to Gemini and accept a bounded JSON change proposal. Validate every proposed path and operation before the plugin writes only into its owned task worktree. Source application keeps the existing explicit job ID, fingerprint, and Git conflict checks.
- Launch npm JavaScript entry points through Node with argument arrays and no shell. Terminate owned child process trees on cancellation. Windows private state requires a verified user-specific DACL; POSIX mode bits are insufficient.
- Ship inspectable platform launchers and a shared resumable installer. Preserve working existing tools, pin Gemini CLI 0.63.0 privately when needed, register a stable installed marketplace, and keep Google sign-in interactive. Use official prerequisite sources.
- Keep the public walkthrough short. Move implementation and validation details to developer documentation. Describe actual behavior without implying vendor ownership or repeating affiliation disclaimers.

## Ownership and stages

1. Platform worker: platform.mjs, runtime.mjs, confinement.mjs, store.mjs, focused tests. Verify launch resolution, cancellation, ACLs, and effective read-only proposal mode.
2. Proposal worker: proposal.mjs, jobs.mjs, proposal/job tests. Verify add/change/delete, full-batch validation, resume backend consistency, and source preservation.
3. Installer worker: installer/, installer tests, pack.mjs. Verify reruns, paths with spaces, failures, stable installation, dependency discovery, and launchers.
4. Coordinator: portable request helper, skills, Git snapshot compatibility, test runner, CI, documentation, version synchronization, integration and independent review.

## Acceptance checks

- Existing macOS tests and actual pinned-upstream policy/tool checks pass.
- Windows CI runs Node 20, 22, and 24 on a real Windows runner; no unsupported runtime guard is removed without boundary tests.
- Windows state is private before prompts or responses are written; malformed paths, junctions, ADS/device names, and duplicate proposals are refused.
- Cancellation terminates a fixture descendant, and background lifecycle reaches a terminal state.
- Implementation changes/additions/deletions remain in a retained worktree until explicit application; staged source state and source bytes remain intact.
- Every skill creates a private request with a portable Node helper. User text stays JSON/stdin data, never shell syntax.
- Installer tests prove idempotency, dependency/version failures, private pinned runtime selection, and usable launch configuration without a provider account.
- Platform ZIPs contain source, license, launchers, and checksums, and omit Git history, credentials, job state, and local logs.
- Independent security, usability, platform, and Astra judgment findings are fixed or explicitly limit the release.
- Authenticated model tests remain pending until the user completes Google sign-in. Fixture and upstream tests never substitute for a live provider claim.

## Release gate

Publish only artifacts built from the exact tested commit. Verify the release checksums and install instructions. Report any unverified live or OS behavior directly rather than promising that no user will encounter an issue.
