# Contributing

Use Node 20+ and Git. The plugin has no runtime npm dependencies. Run `npm test`, `npm run check`, and `npm run test:upstream`. Validate the marketplace, plugin, agents, and skills with Claude Code before changing the integration.

Security-sensitive changes need regression tests that reproduce the original defect. Preserve Google OAuth-only authentication, explicit model selection, private project-scoped job records, restricted review tools, isolated editing, explicit job IDs for mutations, and refusal on unsupported CLI versions. Do not replace a denied operation with unrestricted execution.

Never add credential files, real user transcripts, real tokens, provider output containing private code, or job state to fixtures. Provider tests require a disposable repository and the developer's explicit Google sign-in. Record live-test gaps honestly.

Before supporting another Gemini CLI version, inspect its real parser, settings precedence, policy engine, tool registration, headless event schema, sandbox behavior, and OAuth selection. Update the upstream-package verification contract and run the documented live smoke tests. A permissive version range is not a compatibility test.
