# Gemini Companion for Claude Code

An **unofficial community plugin** that gives Claude Code separate Gemini specialists for code review, adversarial analysis, acceptance judgment, decision advice, debugging, and isolated implementation. It uses Google's official Gemini CLI with your normal **Sign in with Google** authentication. No API key or direct model API integration is required.

This project is not developed, endorsed, or maintained by Google, Anthropic, or OpenAI. It follows the companion-agent pattern demonstrated by [OpenAI's Codex plugin for Claude Code](https://github.com/openai/codex-plugin-cc), with its own implementation and permission boundaries.

## How it works

Claude delegates a concrete task through a plugin skill. The Node runtime builds project context, starts Gemini CLI with Google OAuth and a tool policy, records structured progress, and returns the actual response. Each job starts from a private control workspace with generated settings; the project is supplied as the task target. Gemini receives a separate session and can disagree with Claude's analysis.

The six plugin agents are Claude-side coordinators: `gemini:reviewer`, `gemini:adversarial-reviewer`, `gemini:judge`, `gemini:advisor`, `gemini:investigator`, and `gemini:implementer`. They send substantive model work to Gemini CLI. A Claude agent's model field is not changed to Gemini.

| Capability                   | Behavior                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| Independent second opinion   | Ask Gemini to analyze a problem, compare designs, or investigate evidence.                             |
| Code review                  | Review working changes or a branch against an explicit Git base.                                       |
| Adversarial review           | Challenge assumptions, architecture, trust boundaries, trade-offs, and failure modes.                  |
| Independent judge            | Evaluate work against acceptance criteria with PASS, FAIL, or BLOCKED verdicts and evidence.           |
| Independent advisor          | Compare feasible approaches, rank trade-offs, and recommend a decision with confidence and validation. |
| Debugging and implementation | Investigate without edits, or edit in a retained isolated linked Git worktree.                         |
| Task continuation            | Resume an explicit prior rescue job in its Gemini session.                                             |
| Task handoff                 | Send a self-contained summary and receive a separate Gemini session.                                   |
| Background jobs              | Start, inspect, retrieve, time out, and cancel delegated work.                                         |
| Reviewed patch application   | Apply an eligible isolated patch after source-state and conflict checks.                               |
| Optional completion gate     | Explicitly enable one bounded Gemini review when Claude stops; off by default.                         |

Transfer sends supplied task context; it does not import a native Claude transcript, live tool state, or conversation permissions. Continue a completed transfer through `/gemini:rescue --resume <job-id>` in advisory mode. Sessions created before version 0.1.1 lack the required private control directory and must be replaced by a fresh task. Model access and quota come from your Google account. A paid Gemini subscription does not guarantee every model or unlimited CLI use. See Google's [authentication guide](https://geminicli.com/docs/get-started/authentication/) and [quota and pricing](https://geminicli.com/docs/resources/quota-and-pricing/).

## Requirements

- Node.js 20 or later and Git.
- Claude Code with plugin support. Plugin manifests are validated locally with Claude Code 2.1.296.
- Gemini CLI **0.63.0** on `PATH`. This version is deliberately pinned because tool policy and structured output are security-sensitive integration points. Other versions are rejected until their behavior is validated.
- A Google account signed in through Gemini CLI. Use the Google account associated with your eligible subscription.
- A POSIX platform for process-group cancellation. Windows is currently unsupported. Automated tests use local fixtures; see the live validation procedure below.
- Editing requires macOS and the verified Gemini tool sandbox. Linux supports review/advice/investigation but refuses editing; it has no validated native-file-write boundary in this release.

The plugin runtime has no npm dependencies. Gemini CLI has its own dependencies and system requirements. [Google's installation guide](https://geminicli.com/docs/get-started/installation/)

## Install and authenticate

Install the supported Gemini CLI version if needed:

```sh
npm install --global @google/gemini-cli@0.63.0
gemini
```

Choose **Sign in with Google** in Gemini CLI and complete the browser flow. The plugin reuses Gemini CLI's cached OAuth authentication. It does not copy, print, or manage your credentials. API-key and Vertex authentication are outside this plugin's supported workflow.

From this repository's root, load the plugin for a development session:

```sh
claude --plugin-dir ./plugins/gemini
```

For a persistent installation, register the GitHub repository as a marketplace and install the plugin (the repository is private, so GitHub access is required):

```sh
claude plugin marketplace add sharanlabs/gemini-plugin-cc
claude plugin install gemini@gemini-companion
```

You can use `claude plugin marketplace add .` from the local repository instead. Start a new Claude Code session, then run:

```text
/gemini:setup
```

Setup checks installation and CLI capabilities. By default it does not contact Google and does not prove authentication. To explicitly make a small authenticated request:

```text
/gemini:setup --check-auth
```

## Use Gemini

```text
/gemini:ask Compare these retry designs against our idempotency requirement
/gemini:review
/gemini:review --base main
/gemini:adversarial-review --base main Challenge the transaction boundaries and rollback behavior
/gemini:judge Check the implementation against these acceptance criteria: ...
/gemini:advisor Rank these design options against our constraints: ...
/gemini:rescue Investigate the failing integration test and identify the root cause
/gemini:rescue --edit --background Fix the reproduced regression with the smallest patch
/gemini:status
/gemini:result <job-id>
/gemini:rescue --resume <job-id> Continue the investigation using the new failing case
/gemini:cancel <job-id>
```

You can also ask Claude to delegate naturally: “Have Gemini independently challenge this design” or “Use the Gemini investigator to diagnose this failure.” The review and investigation skills are available to Claude when relevant. Setup, patch application, cleanup, and review-gate settings require an explicit user invocation.

Model selection is optional: add `--model <model-id>` to a delegated task. Omitting it leaves selection to Gemini CLI and your account. The plugin passes your requested model ID to Gemini CLI without substituting one; Gemini CLI retains its own routing behavior and account restrictions. Use `--background` for long tasks; foreground is the default. `--timeout-ms` takes milliseconds, from 1,000 to 3,600,000; the default is 600,000.

Add `--web` when the task requires Gemini's web search and page-fetch tools. These tools are off by default. Their requests can send task-derived text to remote services; retrieved pages remain untrusted evidence.

### Review and apply an implementation

`rescue --edit` gives Gemini file-reading and file-editing tools in a linked worktree, with mandatory macOS tool sandboxing. A worktree alone is not an operating-system sandbox. The runtime refuses unsupported platforms and incompatible inherited settings rather than running edits without the required boundary. Inherited extra workspace directories and custom sandbox permissions must not widen a delegated editing task.

Retrieve the result, inspect its patch, and run the relevant checks through Claude Code. Then explicitly apply it:

```text
/gemini:result <job-id>
/gemini:apply <job-id>
```

Application refuses an ineligible task, changed source state, or patch conflict. Reconcile the changes or delegate a fresh task when that happens. It does not commit, push, merge, or deploy. When a retained worktree is clean and no longer needed:

```text
/gemini:clean <job-id>
```

Cleanup removes only a clean managed worktree with its original HEAD, and refuses dirty files, ignored files, or new commits. Applying a patch to the source does not clean the retained task worktree. Preserve or reconcile its changes before cleanup; keep any useful patch and evidence. Job records and patch files remain in the private state directory after cleanup.

Delegated shell execution is disabled in this release, including requests using `--allow-shell --sandbox`. Independent review reproduced writes outside the worktree through the upstream sandbox's system temporary-directory allowance. Gemini can implement the file change; run project commands and tests through Claude in the returned task worktree, inspect their results, then apply the patch explicitly. Ordinary file editing enables its required sandbox automatically. Linux editing and Windows execution are unsupported. Treat any platform, inherited-setting, custom-policy, or sandbox error as a refusal; never bypass it.

### Handoff and optional review gate

```text
/gemini:transfer Continue this task. Goal: ... Evidence: ... Constraints: ... Checks run: ... Next action: ...
/gemini:gate on
/gemini:gate off
```

The completion gate is off by default. Enabling it authorizes automatic reviews of eligible project changes using your signed-in account and quota. It is bounded to prevent recursive hook loops and can delay Claude's response. A completed review is evidence to assess, not a guarantee that the code is safe to merge.

## Runtime interface

The slash commands use the bundled runtime rather than interpolating prompts into a shell. For tooling, its entry point is:

```sh
node plugins/gemini/scripts/companion.mjs --help
```

`--request <file>` accepts one JSON object. Create the file in a private temporary directory, then provide its absolute path. For example:

```json
{
  "command": "adversarial-review",
  "cwd": "/absolute/path/to/project",
  "base": "main",
  "focus": "Challenge race conditions and rollback assumptions",
  "background": true,
  "timeoutMs": 600000
}
```

Supported request fields are `command`, `cwd`, `prompt`, `focus`, `base`, `model`, `background`, `resume`, `fresh`, `edit`, `allowShell`, `allowWeb`, `sandbox`, `timeoutMs`, `jobId`, `json`, `checkAuth`, and `enabled`. `resume` takes an explicit eligible rescue or transfer job ID; it is mutually exclusive with `fresh`. `edit` is only valid for rescue. `allowShell` remains recognized for diagnostics but requests to enable it are refused. Lifecycle commands take a job ID. Gate takes `enabled:true` or `enabled:false`. Unknown fields are rejected.

Jobs and output are retained in a private project-scoped directory under `~/.local/state/gemini-plugin-cc` by default. `GEMINI_PLUGIN_STATE_DIR` changes that location. Do not place it in a shared directory or commit it. The plugin runs the executable named `gemini` from `PATH`; treat that executable and your Node/Git installation as trusted dependencies.

## Validation

Run the automated suite and Claude's manifest checks from this repository's root:

```sh
npm test
npm run check
npm run test:upstream
claude plugin validate .
claude plugin validate ./plugins/gemini
```

The tests exercise requests, runtime policy, stream parsing, lifecycle behavior, patch isolation and application, and plugin structure using a local fake Gemini process. `test:upstream` downloads the pinned official npm package into a temporary directory (without installation scripts), verifies policies using its real policy engine, and tests the upstream macOS tool sandbox on macOS. It removes its temporary package afterward. These checks do not call the model service, consume subscription quota, or prove that a particular account can access a model.

### Live smoke test

After Google sign-in, run the opt-in automated provider check from this repository:

```sh
npm run test:live -- --run
```

Without `--run`, it prints usage and makes no model requests. The live check uses a synthetic disposable Git repository and private task state, consumes account quota, and exercises authentication, review, a read-only write challenge, isolated implementation, continuation, and patch application. It retains evidence and distinguishes a model refusing a requested write from a tool actually denying one. A failure is not automatically retried. This complements the real-upstream confinement tests; it does not establish that every model response is correct.

For manual validation, use the following checklist:

Use a disposable Git repository containing no private data:

1. Sign in interactively with `gemini`; confirm version `0.63.0`.
2. Load the plugin and run `/gemini:setup --check-auth`. Confirm an authenticated response without credentials appearing in output.
3. Introduce a small intentional bug. Run `/gemini:review` and `/gemini:adversarial-review` against it; verify findings against the source.
4. Ask a review task to write a sentinel file or run a shell command. Verify those operations are denied and the sentinel is absent.
5. Run `/gemini:rescue --edit --background` with a small fix; verify only the isolated worktree changed. Retrieve the result, run relevant tests, and apply the patch.
6. Start another task, cancel its explicit job ID, and confirm the job reaches a terminal state. Resume a completed rescue job and verify its Gemini session ID.
7. Enable the gate explicitly, check one bounded review, then turn it off. Verify delegated shell requests are refused; run necessary tests through Claude in the retained task worktree.

Record platform, Node/Claude/Gemini versions, chosen model, outcomes, and any denied operation. Until these pass, describe provider integration as locally tested with fixtures and not validated against a live account.

## Privacy and contribution

Project context sent to Gemini is processed by Google under the account's applicable terms. Local output can contain source code. Common secret exclusions reduce accidental exposure but do not prove the project contains no sensitive material. Read [SECURITY.md](SECURITY.md) before using the plugin with private code and Google's [terms and privacy notice](https://geminicli.com/docs/resources/tos-privacy/).

The plugin format follows Anthropic's [plugin reference](https://code.claude.com/docs/en/plugins-reference), [skill documentation](https://code.claude.com/docs/en/skills), and [subagent documentation](https://code.claude.com/docs/en/sub-agents). Compatibility changes should include evidence from the target CLI, negative policy tests, and a live smoke test; do not relax the version check to make an unverified release appear supported.

Licensed under [Apache-2.0](LICENSE). Google, Gemini, Claude, and Codex are trademarks of their respective owners.
