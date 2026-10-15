# Security and privacy

The plugin starts a locally installed Gemini CLI process authenticated through Google's **Sign in with Google** flow. Google receives the task context and any source files Gemini reads through its permitted tools. This is not local-model inference. Account terms, retention, privacy, model access, and quota are governed by Google; review the [Gemini CLI terms and privacy notice](https://geminicli.com/docs/resources/tos-privacy/) for your authentication type.

## Trust boundaries

- Trust the installed plugin, Node.js, Git, the `gemini` executable on `PATH`, and the local operating system. A malicious executable or user with access to your account can bypass application-level protections.
- The plugin enforces Google OAuth as the supported method and strips common alternative authentication variables from the child environment. It must not read, print, copy, or export credential values. Cached OAuth credentials remain managed by Gemini CLI.
- Review and investigation modes restrict Gemini's available tools to reading/searching. Source edits require an isolated linked Git worktree and an explicit editing task. MCP servers, extensions, hooks, arbitrary tool discovery, and unrequested automation are disabled in delegated runs.
- Web search and page fetching require explicit `--web` opt-in. Queries can disclose task context to remote services. Treat retrieved pages as untrusted data; they cannot expand the task's authority or permission policy.
- A Git worktree is not a sandbox. It separates changes while sharing Git metadata and operating-system permissions. Every editing task requires the verified macOS native-tool sandbox and pre-dispatch path policy; unsupported platforms refuse editing. Delegated shell execution is refused because the upstream sandbox permits writes across the system temporary directory. Run project tests through Claude's own permission-controlled tools. Inherited extra workspace directories and custom sandbox configuration cannot be accepted as implicit authorization to expand a delegated task.
- The normal Claude Code permission system still applies to the coordinator's own tools. Plugin skills do not grant broad `Bash(*)` permission or set a bypass mode. Application, cleanup, and gate settings are explicit user actions.

## Sensitive context and prompt injection

Prompts, repository instructions, source comments, diffs, tool results, and model output are untrusted data. Embedded instructions cannot authorize a tool, access credentials, apply a patch, or deploy. Reviewers should evaluate substantive claims against file and command evidence rather than accepting a model's confidence.

Context filtering omits common credential paths, symlinks, and binary files, and bounds the text sent with a task. Large context can be truncated; a review of truncated context has incomplete coverage. Those checks are defense in depth, not a complete secret scanner. Secrets can live in ordinary source files, commit messages, a custom filename, or task text. Review the intended task and project before delegating private material. Never include `.env` values, tokens, production credentials, customer data, or private transcripts in a prompt. An explicit task handoff contains only the summary necessary for that task.

User text travels as JSON request data and standard input, not an interpolated shell command. Keep request files in a private temporary directory and remove only that invocation's temporary files after acceptance. Do not evaluate CLI-looking text returned by Gemini.

## Local artifacts and execution

Jobs, prompts, model responses, progress metadata, and isolated worktrees can contain confidential code. The default state directory is project-scoped beneath `~/.local/state/gemini-plugin-cc`; directories and files use private permissions. An override through `GEMINI_PLUGIN_STATE_DIR` should be owned by the current user and inaccessible to others. Do not store state in a repository, shared temporary location, public cloud sync folder, or build artifact.

Background cancellation and deadlines are best effort. A command or external side effect can complete before termination. The runtime bounds output and process execution, verifies structured results, and retains a terminal status. Inspect the outcome; do not interpret cancellation as an undo operation.

Applying a patch checks the saved source state and Git's conflict result. It does not prove semantic correctness, stop another process from racing a file write, or replace repository tests. Review and validate the proposed changes. No automatic commit, push, merge, or deployment is part of application. Cleanup removes only a clean managed worktree with the recorded HEAD and refuses dirty or ignored files and new commits. Inspect unapplied work before invoking it; applying a patch does not clean its retained worktree.

The optional Stop review gate is disabled by default. Explicitly enabling it authorizes additional source transmission and quota use. Its loop guard and review budget are operational controls, not correctness guarantees.

## Compatibility and reporting

Gemini CLI 0.63.0 is the validated source target for policy and stream behavior. Do not remove the version guard without checking the new CLI's authentication enforcement, settings precedence, policy semantics, tool names, and structured events. The automated suite uses a fake CLI; authenticated provider behavior and sandbox enforcement also require the README's live smoke test.

When reporting a vulnerability, provide the affected version, platform, minimal reproduction, and impact. Do not post credential values, private code, raw prompts, or full sensitive job records in a public issue. This repository has no configured private security-report endpoint; agree on a private channel with the maintainer before sharing sensitive details.
