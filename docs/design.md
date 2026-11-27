# Design

`dws-hub` is a **capability layer over the `dws` CLI**. It does not implement DingTalk APIs itself;
it makes `dws` safe to use from automation.

```
your automation / agent
        │
        ▼
   dws-hub (this package)
   ├── src/dws/      call shapes (read / send / reply / edit / emoji / ding / notify)
   ├── src/hub/      channel-agnostic core: anchors · dispatch · cursors · rate limit · ladder · scan · topics
   ├── src/consumers generic consumers: session-follow (inbox delivery)
   └── src/service/  launchd / systemd supervision
        │
        ▼
      dws CLI  ──►  DingTalk
```

## 1. Layers

| Layer | Must not contain | Why |
|---|---|---|
| `src/hub/` | channel words (`dws`, `dingtalk`, `conversation`, `message_id`) | enforced by `src/hub/layering.test.mjs`; keeps core reusable for another channel later |
| `src/dws/` | business logic | every channel-specific quirk lives here and nowhere else |
| `src/consumers/` | knowledge about a specific org | consumers receive events on stdin and return an exit code |
| `src/service/` | references to other tools' install paths | it supervises *this* package only |

## 2. Flow

```mermaid
sequenceDiagram
  participant S as service (listen)
  participant D as dws
  participant H as hub (dispatch)
  participant C as consumer
  participant I as your inbox

  S->>D: pull new events (bounded long-connection + polling authority)
  D-->>S: events
  S->>H: ingest (dedupe by ext_id)
  H->>H: update cursors / rate limit / ladder
  H->>C: spawn(consumer, stdin=events)
  C->>I: deliver (DWS_HUB_INBOX_CMD)
  C-->>H: exit 0 = ack (advance cursor); non-zero = retry with backoff
```

## 3. Data

Single SQLite database (`<data root>/db/dws-hub.db`, WAL) with two families:

- `hub_*` tables: consumers, cursors, events, anchors, topics, delivery ledger, scan runs
- `kv_store`: small namespaced key/value (watermarks, scan state, counters)

`session-follows.json` lives under `<data root>/consumers/` and is safe to edit by hand.

## 4. Failure handling

| Failure | Behaviour |
|---|---|
| `dws` not executable | service self-check exits loudly (never "0 messages") |
| consumer exits non-zero | exponential backoff retry; events are not lost |
| inbox command fails | consumer exits non-zero → retried; message stays in the event table |
| inbox command not configured | message is appended to `logs/inbox-skipped-*.jsonl`, counter surfaced |
| duplicate send | `--uuid` idempotency key; `idempotentHit: true` means do **not** retry |
| degradation | repeated failures downgrade to polling; recovery probe climbs back automatically |

## 5. Safety defaults

- **`notify` is dry-run by default** (`DWS_HUB_ENABLE=1` or `--send` to really send).
  `send` / `emoji` / `ding` / `edit` send for real unless `--dry-run` is passed — one predictable rule
  per command, documented in `--help`.
- **Bounded listening**: each long-connection window is bounded (`--stream-sec`, default 1500s).
  The *process* exits only with `--max-ticks`, or when supervised by `dws-hub service`.
- **No credentials**: authentication belongs to `dws`; this package never stores tokens.
- **Command template** (`DWS_HUB_INBOX_CMD`) is executed as a shell command you configure —
  treat it like any local configuration.

## 6. Configuration

Priority: CLI flag → environment variable → built-in default.
(There is no config file yet; a `<data root>/config.json` layer is a possible future addition.)

| Env | Default | Meaning |
|---|---|---|
| `DWS_HUB_HOME` | `~/.dws-hub` | data root (db, logs, consumer registry) |
| `DWS_HUB_DB` | `<root>/db/dws-hub.db` | database path |
| `DWS_HUB_FOLLOWS` | `<root>/consumers/session-follows.json` | follow registry |
| `DWS_HUB_INBOX_CMD` | *(unset)* | delivery command template |
| `DWS_HUB_SESSION_ID` | *(unset)* | session identifier used by `follow add` |
| `DWS_HUB_SELF_*` | *(unset)* | your own identity (avoid re-delivering your own messages) |
| `DWS_HUB_TZ` | `Asia/Shanghai` | display timezone only |
| `DWS_HUB_MARKER` | `🤖 dws-hub · {consumer}` | outbound marker template |
| `DWS_HUB_ENABLE` | *(unset)* | set to `1` to really send from `notify` (send/emoji/ding/edit use `--dry-run` instead) |
| `DWS_BIN` | `dws` from `PATH` | the `dws` executable |

Advanced tuning knobs (rarely needed): `DWS_HUB_STREAM_SEC`, `DWS_HUB_INTERVAL` (service),
`DWS_HUB_SCAN`, `DWS_HUB_SCAN_MAX_ITEMS`, `DWS_HUB_SCAN_DISPATCH`, `DWS_HUB_SCAN_LOOKBACK_H`,
`DWS_HUB_SCAN_RETAIN_DAYS`, `DWS_HUB_POLL_ATTEMPTS`, `DWS_HUB_POLL_RETRY_MS`, `DWS_HUB_ATME_DAYS`,
`DWS_HUB_INITIAL_LOOKBACK_H`, `DWS_HUB_REACTION_LOOKBACK_MIN`, `DWS_HUB_ING_AFTER_MS`,
`DWS_HUB_EMOJI_ING/DONE/ACK`, `DWS_HUB_MACHINE_PATTERNS`, `DWS_HUB_TZ_OFFSET_H`.

## 7. Generic-only rule

Everything here must hold **for any `dws` user at any company**. If a feature depends on a particular
organization's groups, people, ticket system or internal host, it belongs in the consuming project —
consumers are external commands, so that is easy.

`bun run check:generic` enforces this (built-in structural rules + external denylist, see README).

## 8. Runtime dependency (and why not Go/Rust yet)

The package runs on **Bun** (`bun:sqlite`). That is the only non-Node runtime dependency, and it is a
deliberate trade-off: the service, CLI and tests share one runtime, with no build step.

To keep a Bun upgrade from breaking a supervised install:

- the launchd plist / systemd unit starts a **stable launcher** (`<root>/bin/dws-hub-service`),
  not a versioned Bun path;
- the launcher resolves `bun` at run time (`DWS_HUB_BUN` → `PATH` → common install locations) and
  fails loudly if it cannot find one;
- `dws-hub doctor` reports `bun`, `launcher` and `running-version`.

**When a compiled binary would be worth it** (Go/Rust): if we need any of

1. install with **no runtime** (`brew install` / single-file download),
2. a single static binary for Windows or musl distros,
3. memory/startup budget that Bun cannot meet.

Until then a rewrite would double the codebase and lose the shared sqlite/JS tooling; the launcher
already removes the practical failure mode (Bun path drift).
