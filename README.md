# dws-hub

> A **reliable capability layer** for the [DingTalk workspace CLI (`dws`)](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli).
> Generic by design: **no company-specific business logic** — see [Generic-only rule](#generic-only-rule).

`dws` is a CLI. `dws-hub` is the layer that makes it safe to automate:

| Capability | Why it matters |
|---|---|
| **Idempotent send** | retries must not create duplicate messages (`--uuid`, `idempotentHit`) |
| **@ rendering** | group mentions need a body placeholder paired with `--at`; otherwise a literal `<@id>` lands in the chat |
| **Read-back verification** | assert on the specific `messageId` instead of guessing from history |
| **Edit instead of repost** | fix a wrong message in place, keeping the reply chain intact |
| **Bounded listening** | one long-connection window is bounded; polling is the authority; cursors are per consumer |
| **Dispatch** | subscribe by scope / keywords, independent cursors, trigger merging |
| **Rate limiting** | message/DING quotas + quiet hours, so automation does not get you muted |
| **Degradation ladder** | failures downgrade to polling and recover automatically, with receipts |

## Install

Requires **Bun ≥ 1.1** (`bun:sqlite`) and the **`dws`** CLI on `PATH`, logged in with your own identity.
Tested on macOS (launchd) and Linux (systemd `--user`, dws v1.0.x).

> **Status: 0.1.0 — not published to npm yet.** The CLI surface is ported; publication is gated on an
> independent acceptance run. Until then, run from source:

```bash
git clone https://github.com/minonl/dws-hub.git
cd dws-hub
bun bin/dws-hub.mjs --help
# optional: put it on PATH
bun link
```

After publication the two commands below will work:

```bash
bun add -g dws-hub
bunx dws-hub --help
```

## Quick start

```bash
# `doctor` prints a checklist; a missing optional item (e.g. inbox) does not fail the process.
# `--strict` makes the exit code follow the overall verdict.
bun bin/dws-hub.mjs doctor            # bun / dws / auth / data root / inbox / service
bun bin/dws-hub.mjs read auth         # is dws authenticated?
bun bin/dws-hub.mjs read atme --days 1  # messages that mention me
```

(After `bun link` or installation, drop the `bun bin/dws-hub.mjs` prefix.)

## Commands

| Group | Commands |
|---|---|
| Read | `read auth` · `read atme` · `read chat` · `read search` |
| Send | `send dm` · `send group` · `send reply` · `send chat` |
| Correct | `edit` · `emoji add/remove` · `ding send` |
| Notify | `notify --consumer --title [--text] [--strength info\|strong\|critical] [--needs-decision]` — `info` = self-message; `strong` = DING → todo → calendar → self-message; `critical` = phone DING → …; dry-run by default (`--send` or `DWS_HUB_ENABLE=1` to really send) |
| Listen / dispatch | `listen` · `consumers list/add/rm` · `follow add/rm/list/sync/status/scopes` · `pull` · `tick` · `probe` · `stream-status` · `health` · `ding-log` |
| Topics | `topic add/link/list/show/feed/reply/recall/status/auto/watch` |
| Anchors | `anchors list/reply/rescan` |
| Operate | `scan status/run/coverage/prune` · `service install/uninstall/status` · `doctor` · `consume <consumer>` · `todo list/add` |

`dws-hub --help` is the source of truth for flags.

## Data & configuration

| Item | Default | Override |
|---|---|---|
| Data root | `~/.dws-hub` | `DWS_HUB_HOME` |
| Database | `<root>/db/dws-hub.db` | `DWS_HUB_DB` |
| Follow registry | `<root>/consumers/session-follows.json` | `DWS_HUB_FOLLOWS` |
| Service log | `<root>/logs/service.log` | — |
| Undelivered messages | `<root>/logs/inbox-skipped-<date>.jsonl` | — |
| Inbox delivery | disabled | `DWS_HUB_INBOX_CMD` (shell template) |
| Session id | *(unset)* | `DWS_HUB_SESSION_ID` |
| Own identity | *(unset)* | `DWS_HUB_SELF_USER` / `DWS_HUB_SELF_OPEN_ID` / `DWS_HUB_SELF_NAME` |
| Display timezone | `Asia/Shanghai` | `DWS_HUB_TZ` |
| `dws` binary | `dws` from `PATH` | `DWS_BIN` |
| Outbound marker | `🤖 dws-hub · {consumer}` | `DWS_HUB_MARKER` |
| Real send for `notify` | off (dry-run) | `DWS_HUB_ENABLE=1` or `--send` |

Core configuration and design notes: [docs/design.md](docs/design.md) (the most common tuning knobs are listed there).

**Send semantics differ by command** — this is deliberate and worth remembering:

- `notify` is **dry-run by default**; `DWS_HUB_ENABLE=1` (or `--send`) really sends.
  Dry-run still writes one delivery-ledger row and, with `--needs-decision`, creates an anchor; it prints a JSON receipt.
- `send` / `emoji` / `ding` / `edit` **send for real by default**; pass `--dry-run` to preview.

The package never reads another tool's data directory and has no dependency on any agent framework.
Delivery targets are pluggable: configure a command that accepts text + an idempotency key.

```bash
# example: deliver into any inbox CLI you already use
DWS_HUB_INBOX_CMD='my-inbox add --to "$DWS_HUB_INBOX_TO" --subject "$DWS_HUB_INBOX_SUBJECT" \
  --body "$DWS_HUB_INBOX_BODY" --idempotency-key "$DWS_HUB_INBOX_KEY"'
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success, idempotent hit, or dry-run |
| `1` | business failure (read-back assertion failed, unhealthy stream) |
| `2` | bad arguments |
| `3` | downstream `dws` failure |
| `4` | authentication missing |
| `5` | unexpected |

CLI help and error messages are currently in Chinese; the docs are in English.

## Glossary

| Term | Meaning |
|---|---|
| **scope** | a conversation identity: `self`, `group:<cid>` or `direct:<uid>` |
| **ext_id** | the channel's message id (unique per message, used for dedupe) |
| **consumer** | an external command that receives events on stdin and exits `0` to acknowledge |
| **follow** | a subscription binding a session id to scopes; new messages are delivered to that session |
| **anchor** | the link between an outgoing notification and the replies it triggers |
| **topic** | a subject (e.g. `mr:group/repo!12`) that groups several conversations and messages |

## Service

```bash
dws-hub service install     # launchd (macOS) or systemd --user (Linux)
dws-hub service status
dws-hub service uninstall
```

The supervisor restarts `listen` on failure; single-instance is enforced by an atomic lock.

## Generic-only rule

This project only ships logic that holds **for any `dws` user at any company**. Anything that depends on
a particular organization's groups, people, ticket systems or internal hosts belongs in the *consuming*
project — consumers are plain external commands, so that split is cheap.

Enforced by `bun run check:generic` (also runs in CI and on `npm pack`):

- built-in structural checks (looks like a real conversation id / a private data root)
- an external denylist (data, not code):
  - local: `scripts/denylist.txt` (git-ignored)
  - CI: `DWS_HUB_DENYLIST` env var (injected from a secret)

See [scripts/denylist.example.txt](scripts/denylist.example.txt).

## Not affiliated

This is an independent, unofficial project. It is **not affiliated with, endorsed by, or supported by**
DingTalk / Alibaba. `DingTalk` and `dws` are used descriptively to refer to the upstream CLI.

## License

MIT — see [LICENSE](LICENSE).
