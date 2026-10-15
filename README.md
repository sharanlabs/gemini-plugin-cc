# Gemini Companion for Claude Code

Use Gemini as an independent reviewer, judge, advisor, investigator, or implementation partner inside Claude Code. Sign in with your Google account—no API key required.

## Install

1. Download and extract the [macOS installer](https://github.com/sharanlabs/gemini-plugin-cc/releases/download/v0.2.1/gemini-companion-macos-v0.2.1.zip) or [Windows installer](https://github.com/sharanlabs/gemini-plugin-cc/releases/download/v0.2.1/gemini-companion-windows-v0.2.1.zip).
2. Open **Install.command** on Mac or **Install.cmd** on Windows. Setup installs the supported Gemini CLI privately. If Git or Claude Code is missing, follow the official setup it opens, then run the installer again.
3. Open **Sign in to Gemini**, choose **Sign in with Google**, and finish in your browser. Wait for the Gemini chat prompt, then exit with `/quit`, then open **Launch Claude** in the installed folder.

In Claude Code, run:

```text
/gemini:setup --check-auth
/gemini:review
```

The installer preserves existing software. It provides Node automatically if needed. OS security prompts may require permission to open the downloaded launcher. Claude Code needs its own account access; Gemini model access and quota follow your Google account and eligible subscription. [Google sign-in and account requirements](https://geminicli.com/docs/get-started/authentication/)

Already have Node 20+, Git, Claude Code, and Gemini CLI 0.63.0? Install directly:

```sh
claude plugin marketplace add sharanlabs/gemini-plugin-cc
claude plugin install gemini@gemini-companion
```

## Use it

| Task | Command |
| --- | --- |
| Review changes | `/gemini:review` |
| Challenge a design or change | `/gemini:adversarial-review Find failure modes and counterexamples` |
| Judge against requirements | `/gemini:judge Check this work against: …` |
| Compare approaches | `/gemini:advisor Compare these options: …` |
| Ask a second opinion | `/gemini:ask Explain the trade-offs in this design` |
| Investigate a failure | `/gemini:rescue Find the root cause of this failing test` |
| Implement a fix | `/gemini:rescue --edit --background Fix this reproduced bug` |
| Check progress | `/gemini:status` |
| Read the result | `/gemini:result <job-id>` |
| Continue a task | `/gemini:rescue --resume <job-id> Investigate this new evidence` |
| Cancel | `/gemini:cancel <job-id>` |

You can also ask Claude: “Have Gemini independently review this change.” Add `--model <model-id>` to select an account-accessible model, `--web` to allow web research, or `--background` for longer tasks.

Implementation stays in a separate Git worktree. Inspect the patch and run your tests there, then explicitly apply it with `/gemini:apply <job-id>`. Delegated shell commands are disabled; Claude runs authorized project checks. macOS uses validated native write tools; Windows uses validated file-change proposals.

`/gemini:transfer` starts a separate session from your handoff summary; it does not import a native Claude transcript. `/gemini:gate on` enables an optional completion review; it is off by default.

## Development and verification

```sh
npm test
npm run check
npm run test:upstream
```

These tests use fixtures and the pinned Gemini CLI package without model requests. After Google sign-in, run the opt-in **live smoke test** with `npm run test:live -- --run`.

See the [developer reference](docs/reference.md), [validation record](docs/validation.md), and [security and privacy details](SECURITY.md). Project context sent to Gemini is processed by Google. Review sensitive material before delegating it.

[Apache-2.0](LICENSE) · [Contributing](CONTRIBUTING.md) · [Releases and checksums](https://github.com/sharanlabs/gemini-plugin-cc/releases)
