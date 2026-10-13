# Validation record

Date: 2026-10-13.

Local environment: macOS, Node 24.21.0, npm 11.19.0, Claude Code 2.1.296. The official Gemini CLI 0.63.0 npm package was downloaded into temporary evidence storage; no global Gemini installation or credential contents were used.

## Results

- Full automated suite with the real upstream policy/sandbox package: **68 passed, 0 failed, 0 skipped**.
- Default offline suite: **66 passed, 0 failed, 2 upstream-package checks skipped**. `npm run test:upstream` runs those checks with the actual pinned package; on macOS all **21 runtime tests passed**.
- `npm run check`: JavaScript syntax and JSON validation passed.
- Claude plugin validation passed for marketplace, plugin, skills and agents.
- Actual packaged CLI `--version`/`--help` probe: 0.63.0 with all required capabilities. This was a non-model invocation.
- Detached-worker integration exercised launcher exit, status polling and cancellation of the actual fake-Gemini subprocess. Runtime tests also verified descendant process-group termination.
- Real temporary Git repositories exercised staged/unstaged/untracked snapshots, merge-base reviews, staged and unstaged deletions, source drift, symlink ancestors, incremental patch application and staging preservation.
- Independent implementation review reproduced snapshot/deletion/path-traversal/session-concurrency and retention defects. Fixes were incorporated and regression-tested.
- Upstream npm integrity: `sha512-mmhqMmAdsoplCzrLQQC4yJBqr4uSKXghnrLspgUU6N9drmsaq7pi7oF09skRYzEq2dYK6eMT4UpFQP6rG2o/ew==`.

## Not verified

No cached Gemini Google OAuth sign-in existed on the build machine. No authenticated model request, account quota entitlement, real model review quality, or live Claude-to-Gemini workflow was claimed. Use the README live smoke test after signing in. No credentials were requested, copied, read or committed.

Node 20/22 and Linux coverage is delegated to the checked-in GitHub CI matrix; this local record does not pre-claim remote results. Windows and Linux shell delegation are unsupported. macOS sandbox tests establish specific tested boundaries, not complete security or confidentiality.

A stale heartbeat is shown as unresponsive while the worker may still be alive; only a verified dead PID becomes a persisted interrupted job. A hard-killed worker may leave an exclusive-operation lock. The error identifies the exact lock for inspection; never remove a lock until its owner is confirmed dead. Dirty task worktrees and committed task results are retained rather than force-deleted.

## Reproduce

```sh
npm test
npm run check
npm run test:upstream
claude plugin validate .
claude plugin validate plugins/gemini
claude plugin validate plugins/gemini/skills
claude plugin validate plugins/gemini/agents
```

`test:upstream` downloads the exact official package without installation scripts; it does not authenticate or make model calls. For one combined full-suite run, set `GEMINI_TEST_BUNDLE` to the unpacked pinned package's `bundle/chunk-2V7FO5QV.js` while running `npm test`.
