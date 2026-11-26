# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

- Use GitHub's private vulnerability reporting: **Security → Report a vulnerability** on this repository.
- Include: affected version, a minimal reproduction, and the impact you observed.
- Do **not** include real conversations, credentials, or personal data in the report; redact them.

We aim to acknowledge within 72 hours and to ship a fix or mitigation for confirmed issues.

## Scope notes

`dws-hub` is a local CLI layer over the `dws` CLI. It does not run a server and does not send data
anywhere except the DingTalk endpoints that `dws` itself calls.

Two things are **by design** and are not vulnerabilities:

1. **`notify` is dry-run by default** (`DWS_HUB_ENABLE` gates real sends). Commands that create or
   modify messages (`send`, `emoji`, `ding`, `edit`) send for real unless you pass `--dry-run`.
2. **Command-template delivery** (`DWS_HUB_INBOX_CMD`) executes a shell command you configure.
   Treat it like any local configuration: only point it at commands you trust.

## Handling of secrets

- The project never stores credentials; authentication is delegated to `dws`.
- Never paste tokens, cookies, or real conversation IDs into issues, PRs, or test fixtures.
