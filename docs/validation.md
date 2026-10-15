# Validation record

## Provider acceptance failed — 2026-10-15

A live user account attempt returned `This client is no longer supported for Gemini Code Assist for individuals`. Google's [current deprecation record](https://developers.google.com/gemini-code-assist/docs/deprecations) confirms that personal free, Pro and Ultra requests through Gemini CLI ended on June 18, 2026. Its [Antigravity FAQ](https://antigravity.google/docs/faq/#can-i-use-antigravity-cli-headless-mode-in-third-party-coding-agents-or-automate-account-switching) also excludes wrapping the replacement CLI inside consumer third-party coding agents, explicitly including Claude Code.

The intended subscription-only Claude Code integration therefore does not pass acceptance. Earlier sign-in and installation checks established only the enumerated local/component behavior. Their passing results do not establish supported provider access. Browser handling changes cannot resolve this service rejection. No Antigravity wrapper, token reuse, credential migration, or API-key fallback has been added.

The historical results below are retained for audit and must not be read as consumer release-readiness certification. Source and release notices now identify the blocker. The official standalone Antigravity CLI offers its own local browser sign-in separately from Claude Code.

## 0.2.2 — 2026-10-15

A user screenshot identified the exact interactive failure: `Authentication consent could not be obtained`. Public pinned CLI source and a credential-free reproduction confirmed that initial authentication runs before the UI registers its consent listener; a rejected authentication promise is then reused by menu retries. The sign-in launcher now sets the supported `NO_BROWSER=true` option to use Google's link-and-code flow, retaining normal Google account authentication and CLI-managed credential storage. No credential contents were inspected or copied.

Regression tests check both direct installer sign-in and the actual installed launcher child environment, including an inherited `NO_BROWSER=false`. Account authorization and authenticated workflows require the user to finish the Google link-and-code flow; successful fixture tests do not establish that live outcome.

Local macOS results: **131 passed, 0 failed, 6 expected platform/upstream skips**; pinned-upstream verification: **30 passed, 0 failed, 0 skipped**. Syntax/JSON, whitespace and all four Claude validators pass. The private login settings also disable global CLI update notices so they do not recommend changing the tested runtime through a separate global install.

## 0.2.1 — 2026-10-15

A real authenticated setup attempt exposed an upstream OAuth consent prompt on structured stdout when reusable Google authentication was unavailable. Delegated subprocesses now force browser suppression, and the pinned CLI authentication exit code is reported as `AUTH_REQUIRED` with interactive sign-in guidance. No credential contents were inspected. This fixes startup failure handling; it does not establish account entitlement or successful model use.

Regression checks cover overriding inherited browser settings, safe authentication diagnostics, strict malformed-stream rejection, the real upstream authentication exit code, and actual configuration loading with browser suppression on macOS and Windows. Run the checks below to reproduce; authenticated model and Claude-to-Gemini routing checks remain pending successful saved Google sign-in.

Local macOS results: **131 passed, 0 failed, 6 platform/upstream-only skips**; pinned-upstream checks: **30 passed, 0 failed, 0 skipped**. Syntax/JSON, whitespace checks and all four Claude marketplace/plugin/component validators pass.

## 0.2.0 — 2026-10-15

The release adds native Windows execution, validated Windows edit proposals, and downloadable macOS/Windows installers. The historical 0.1.1 platform limitations below describe that older release.

Local macOS checks: **130 passed, 0 failed, 6 platform/upstream-only skips**; real pinned-upstream verification: **29 passed, 0 failed, 0 skipped**. JavaScript syntax/JSON and whitespace checks pass. Installer tests cover Google-only sign-in isolation, version validation, stable launchers after updates, failed setup recovery, immutable release packaging and sensitive-path exclusions.

GitHub CI runs Node 20/22/24 on Windows, macOS and Ubuntu. Separate macOS/Windows jobs exercise actual upstream configuration and native read tools, plus ZIP extraction, checksums, private Gemini startup, real Claude plugin registration, installed/enabled version, rerun and platform bootstrap without Node on PATH. The Windows bootstrap runs through Windows PowerShell 5.1, matching the download launcher. These checks use isolated configuration and make no model request.

All **13 jobs passed** for the published 0.2.0 tree, including the [main-branch run](https://github.com/sharanlabs/gemini-plugin-cc/actions/runs/38738860739). The public macOS/Windows ZIP downloads and uploaded SHA-256 checksums were verified after publication. Astra's final independent verdict passed the tested installer/offline runtime scope; authenticated provider and live coordinator acceptance remained pending.

Independent implementation, platform, installer-security and Astra reviews produced concrete regressions that were fixed: Windows CRLF/path behavior, process exit races, baseline files hidden by changed ignore rules, untracked sensitive files in archives, assistant configuration in context, alternate authentication selectors during sign-in, and launchers pinned to a pruned Claude version. Review evidence does not certify arbitrary model responses.

Reproduce the release checks:

```sh
npm test
npm run check
npm run test:upstream
node scripts/verify-installer.mjs
```

`verify-installer` requires Claude Code and Git, downloads public pinned runtimes, and uses disposable state. `npm run pack -- --out <directory>` requires a clean committed source tree and writes the platform ZIPs and SHA-256 checksums from immutable Git objects.

Google browser sign-in, account entitlement, authenticated Gemini responses and live Claude-to-Gemini coordination remain a separate acceptance check. After signing in, run `/gemini:setup --check-auth` and `npm run test:live -- --run`. Credentials are never inspected or copied by the validation tools. Download launchers are unsigned; operating-system or organization policy can require an explicit open action. Git and Claude Code remain prerequisites, with official setup guidance when missing.

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
