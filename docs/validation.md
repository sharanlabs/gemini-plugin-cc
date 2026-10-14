# Validation record

## 0.1.1 repair — 2026-10-14

Environment: macOS, Node 24.21.0, npm 11.19.0, Claude Code 2.1.300, installed official Gemini CLI 0.63.0. Google credential contents were never inspected or copied.

- Offline suite: **85 passed, 0 failed, 3 upstream-only checks skipped**.
- Real upstream verification: **27 passed, 0 failed, 0 skipped**. The combined suite with the pinned installed bundle runs all **88 tests**.
- JavaScript syntax/JSON and Git whitespace checks passed. All four Claude marketplace/plugin/skills/agents validators passed.
- Actual installed CLI setup reports version 0.63.0 and every required capability; authentication remains separately unchecked.
- Real upstream regression captures generated runtime arguments and feeds them into the actual strict CLI parser, then passes the parsed arguments into the actual settings/configuration startup. This caught and removed an unsupported `--ignore-env` flag.
- Effective settings enforce Google OAuth and native tool sandboxing, disable hooks/skills/Gemma/IDE, and include only the task target. An empty private control dotenv file prevents loading synthetic inherited environment content. Restrictive inherited trust selectors are stripped before startup.
- Actual extension discovery verifies the synthetic installed extension remains inactive under `--extensions none`. Actual MCP initialization verifies the inherited synthetic server does not start. The initialized registry contains exactly the six permitted reading/editing tools.
- Actual native write/replacement tests deny original source, global Gemini memory, control settings, traversal and symlink escapes, while allowing task-file creation and replacement. Source/global sentinels remain unchanged.
- Shell delegation is refused even with explicit sandbox opt-in because independent review reproduced the upstream system temporary-directory allowance. Linux editing and Windows execution remain unsupported.
- Astra independently reran **36 targeted tests with no skips**, including actual upstream components, and returned PASS for offline startup and macOS confinement. Live provider readiness remains unverified.
- The opt-in live smoke runner has **8 helper/safety tests**. Its default invocation prints help without model requests. The live run is pending Google sign-in.

### Remaining live checks

No Google OAuth cache exists on this machine at the latest existence-only check. The user must complete `gemini` → **Sign in with Google**, then run `/gemini:setup --check-auth` and `npm run test:live -- --run`. Account entitlement, real provider responses and continuation are not established by component tests.

An actual Claude command-routing test was attempted in a synthetic directory with restricted tools and no Google request. Claude returned its session-limit error before running the setup skill. Manifest validation and installation do not substitute for that live coordination check; retry `/gemini:setup` in a new Claude session after its quota resets.

The initial 0.1.0 fixture checks missed real settings precedence and native-write boundaries. They are preserved below as historical results, not release-readiness evidence. Use version 0.1.1 or later.

## Historical 0.1.0 build record

Date: 2026-10-13.

Local environment: macOS, Node 24.21.0, npm 11.19.0, Claude Code 2.1.296. The official Gemini CLI 0.63.0 npm package was downloaded into temporary evidence storage; no global Gemini installation or credential contents were used.

## Results

- Full automated suite with the real upstream policy/sandbox package: **71 passed, 0 failed, 0 skipped**.
- Default offline suite: **69 passed, 0 failed, 2 upstream-package checks skipped**. `npm run test:upstream` runs those checks with the actual pinned package; on macOS all **21 runtime tests passed**.
- `npm run check`: JavaScript syntax and JSON validation passed.
- Claude plugin validation passed for marketplace, plugin, skills and agents. Real marketplace registration and plugin installation also succeeded inside an isolated temporary `CLAUDE_CONFIG_DIR`; normal user settings were not changed.
- Actual packaged CLI `--version`/`--help` probe: 0.63.0 with all required capabilities. This was a non-model invocation.
- Detached-worker integration exercised launcher exit, status polling and cancellation of the actual fake-Gemini subprocess. Runtime tests also verified descendant process-group termination.
- Real temporary Git repositories exercised staged/unstaged/untracked snapshots, merge-base reviews, staged and unstaged deletions, source drift, symlink ancestors, incremental patch application and staging preservation. Unchanged tracked assistant settings are preserved by Git object ID without reading their contents; changed settings are refused.
- Independent implementation review reproduced snapshot/deletion/path-traversal/session-concurrency and retention defects. Fixes were incorporated and regression-tested.
- Upstream npm integrity: `sha512-mmhqMmAdsoplCzrLQQC4yJBqr4uSKXghnrLspgUU6N9drmsaq7pi7oF09skRYzEq2dYK6eMT4UpFQP6rG2o/ew==`.

## Not verified

No cached Gemini Google OAuth sign-in existed on the build machine. No authenticated model request, account quota entitlement, real model review quality, or live Claude-to-Gemini workflow was claimed. Use the README live smoke test after signing in. No credentials were requested, copied, read or committed.

GitHub CI succeeded on the initial implementation for Node 20, 22 and 24 on Ubuntu and macOS, including a separate upstream-policy/sandbox job: https://github.com/sharanlabs/gemini-plugin-cc/actions/runs/38464440324 . The latest revision is independently checked by the current CI run. Windows and Linux shell delegation are unsupported. macOS sandbox tests establish specific tested boundaries, not complete security or confidentiality.

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
