# Project instructions

This is an unofficial Gemini companion for Claude Code. It delegates substantive reasoning to the installed Gemini CLI using normal Google sign-in; never introduce API-key setup or imply Google/Anthropic ownership.

Read README.md and SECURITY.md before changing the runtime. Preserve existing user checkout changes. Never execute task text through a shell, copy/read authentication credentials, silently widen tools, bypass version checks, or apply a task without an explicit job ID and source-state checks.

Run `npm test`, `npm run check`, and `npm run test:upstream`; the last command downloads the exact pinned public npm package without installation scripts and makes no model call. For packaging changes run Claude plugin validation for the repository, plugins/gemini, plugins/gemini/skills and plugins/gemini/agents. Keep runtime, context, lifecycle and packaging tests aligned with their actual boundaries. Do not claim a live provider test was run from fixture tests.

Edits remain in retained linked worktrees until explicitly applied. A worktree is not a sandbox. Every edit requires the verified macOS native-tool sandbox and canonical path checks. Delegated shell is refused: the upstream temporary-directory allowance does not preserve source isolation. Linux editing and Windows execution require separately verified boundaries before enabling them. Keep review gate disabled by default and prevent recursive usage loops.

Use a private per-job control workspace for effective Gemini settings and stable session continuation. User-owned temporary system settings are ignored by upstream and cannot enforce restrictions. Verify loaded settings and actual native tool execution, including inherited configuration, before claiming isolation. Preserve normal Google authentication without inspecting or copying credentials.
