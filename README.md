# Gemini Companion for Claude Code

**Personal Google subscription support is unavailable. Do not use the v0.2.x installers for free, Google AI Pro, or Ultra account access inside Claude Code.**

Google [ended Gemini CLI access for these accounts on June 18, 2026](https://developers.google.com/gemini-code-assist/docs/deprecations). Google also [explicitly excludes wrapping Antigravity CLI inside Claude Code or other third-party coding agents under consumer plans](https://antigravity.google/docs/faq/#can-i-use-antigravity-cli-headless-mode-in-third-party-coding-agents-or-automate-account-switching). Changing browser handling or copying an authorization code cannot restore this backend's personal-account access.

The released installers and component tests do **not** establish a working consumer subscription integration. A live account attempt returned: `This client is no longer supported for Gemini Code Assist for individuals.` Earlier instructions below are retained as historical implementation reference; they are not a supported installation path for these accounts.

For automatic browser sign-in with a personal account, use the [official standalone Antigravity CLI](https://github.com/google-antigravity/antigravity-cli#authentication). It runs separately from Claude Code. This project does not wrap Antigravity consumer authentication or introduce an API-key fallback.

## Historical implementation and installation

The v0.2.x implementation delegates independent review, judgment, advice, investigation, and isolated implementation to Gemini CLI 0.63.0 through **Sign in with Google**. Provider access for the intended personal-account workflow has failed live validation. Other account types are not certified by this project's offline tests.

1. Download and extract the [macOS installer](https://github.com/sharanlabs/gemini-plugin-cc/releases/download/v0.2.2/gemini-companion-macos-v0.2.2.zip) or [Windows installer](https://github.com/sharanlabs/gemini-plugin-cc/releases/download/v0.2.2/gemini-companion-windows-v0.2.2.zip).
2. Open **Install.command** on Mac or **Install.cmd** on Windows. Setup installs the supported Gemini CLI privately. If Git or Claude Code is missing, follow the official setup it opens, then run the installer again.
3. Open **Sign in to Gemini**. Open the Google link shown in Terminal, sign in, and paste the returned authorization code into that Terminal only. When the Gemini chat prompt appears, enter `/quit`, then open **Launch Claude** in the installed folder.

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
