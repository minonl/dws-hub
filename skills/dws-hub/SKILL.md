---
name: dws-hub
description: Reliable operations for the DingTalk workspace CLI (dws) — read messages, send/deliver notifications, reply in thread, edit a wrong message, listen for new messages, dispatch events to consumers. Use when you need to operate DingTalk through dws and want idempotency, correct @ rendering, read-back verification and bounded listening instead of raw CLI calls.
metadata:
  requires:
    bins:
      - dws
      - bun
---

# dws-hub

`dws` is a CLI. `dws-hub` is the layer that makes it safe to automate. **Prefer this over raw `dws`**
for read / send / reply / edit / listen; use raw `dws` only for capabilities not covered here, and say so
in your output.

## 0. Setup

```bash
# 0.1.0 is not on npm yet — run from source:
git clone https://github.com/minonl/dws-hub.git && cd dws-hub
bun bin/dws-hub.mjs --help
bun link                    # optional: puts `dws-hub` on PATH

# after publication:
bun add -g dws-hub
bunx dws-hub --help
```

Then: `dws-hub doctor`（bun / dws / auth / data root / inbox / service）.

- Data root: `DWS_HUB_HOME` (default `~/.dws-hub`).
- **Send semantics differ by command** (be precise, this bites):
  - `notify` is **dry-run by default**; `DWS_HUB_ENABLE=1` (or `--send`) to really send.
  - `send` / `emoji` / `ding` / `edit` **send for real by default**; pass `--dry-run` to preview only.
- Exit codes: `0` ok / idempotent hit / dry-run · `1` business failure (read-back assert, unhealthy stream) ·
  `2` bad args · `3` downstream (`dws`) failure · `4` auth missing · `5` unexpected.

## 1. Read (no side effects)

```bash
dws-hub read atme  --days 7 [--group "<name|cid>"] [--senders id1,id2]
dws-hub read chat  --conversation-id "<cid>" [--limit 20] [--start "2026-01-01 00:00:00"]
dws-hub read search --query "keyword" [--group "<name|cid>"] [--days 7] [--at-me]
```

Output is JSON: `{ ok, command, count, messages, … }`. **Check `count` and `complete/stopReason`
before concluding "nothing there"** — incomplete ≠ empty.

## 2. Send

```bash
# group message; @ mentions need a body placeholder paired with --at, otherwise the send is rejected
dws-hub send group --group "<cid>" --text "hi <@openId>" --at "<openId>"
# reply in thread (do NOT write @name and do NOT pass --at: the API adds it)
dws-hub send reply --ref-msg-id "<msgId>" --conversation-id "<cid>" --text "…"
# single chat
dws-hub send dm --to "<id>" --text "…" [--to-kind open]
dws-hub send chat --chat-id "<cid>" --text "…" [--at "<openId>"] [--dry-run]
```

## 3. Correct

```bash
# wrong message → edit in place (never delete-and-repost); verifies the read-back has no literal <@…>
dws-hub edit --conversation-id "<cid>" --message-id "<msgId>" --text "new body" [--dry-run]
dws-hub emoji add --conversation-id "<cid>" --msg-id "<msgId>" --emoji "🎉" [--dry-run]
dws-hub ding send --to "<openId>" --content "…" --type app [--dry-run]
dws-hub ding send --to "<openId>" --content "…" --type sms --allow-cost    # sms/call = channel, recipient is still an openDingTalkId; --allow-cost only for sms|call
```

## 4. Listen & dispatch

```bash
# one connection is bounded (--stream-sec); the *process* exits only with --max-ticks
# or when a supervisor rotates it — run it under `dws-hub service install` for 24/7.
dws-hub listen --interval 60 --stream-sec 1500 [--max-ticks N]

dws-hub consumers add --name my-inbox --targets 'group:<cid>,atme:*' --cmd '<shell command>'
dws-hub consumers list
dws-hub consumers rm --name my-inbox

dws-hub follow add --scope group:<cid> [--label "name"] (--session <id> | DWS_HUB_SESSION_ID)
dws-hub follow list
dws-hub follow status
dws-hub follow sync

dws-hub health
dws-hub stream-status
dws-hub ding-log --since 2026-01-01
```

A consumer receives `{"consumer":…, "events":[…]}` on **stdin**; exit `0` = acknowledged (cursor advances),
non-zero = retried with backoff.

## 4.5 Notify (stepped delivery) and anchors

```bash
# info = self-message; strong = DING → todo → calendar → self-message; critical = phone DING → …
dws-hub notify --consumer my-job --title "build failed" [--text "…"] \
  [--strength info|strong|critical] [--needs-decision] [--at 2026-01-01T00:00:00Z] [--force]

dws-hub anchors list [--status open]
dws-hub anchors reply --id <anchorId> --text "…"
dws-hub anchors rescan [--minutes 120]
```

- **Dry-run by default**: `notify` does not call `dws` unless `--send` or `DWS_HUB_ENABLE=1`.
  It still writes one delivery-ledger row and (with `--needs-decision`) creates an anchor, and prints a JSON receipt.
- `--needs-decision` creates an **anchor**: anyone can reply by quoting the notification, and the reply is linked back.

## 5. Hard rules (learned the hard way)

1. **Reply mentions are automatic** — writing `@name` or passing `--at` on `reply` produces a double mention
   or a literal `<@…>` in the message.
2. **Group mentions must be paired** — placeholder in the body **and** `--at`; otherwise the send is refused (exit 2).
3. **Verify only your own `messageId`** — literals in older messages are historical; do not delete a successful send.
4. **Idempotency** — pass `--uuid` when retrying; `idempotentHit: true` means it already happened; never retry blindly.
5. **Explicit fallback** — if `dws-hub` lacks a capability, use `dws` and print `fallback: dws — <reason>` on the first line.

## 6. Troubleshooting

| Symptom | Look at |
|---|---|
| Sent but no mention | `read chat` around that `messageId`: literal `<@…>` means wrong call shape |
| Empty read but messages exist | `complete/stopReason`, group name uniqueness, time window |
| Exit 3 with an auth message / Exit 4 | `dws-hub read auth`; then `dws auth login --device` |
| Service not working | `dws-hub health`, `dws-hub service status`, `<data root>/logs/service.log` |
| Consumer not delivering | `dws-hub follow status`; `logs/inbox-skipped-*.jsonl` when `DWS_HUB_INBOX_CMD` is unset |
