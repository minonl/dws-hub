# Changelog

All notable changes to this project are documented here.

## [0.1.0] — 2026-11-26

### Added

- **CLI**: `read` (auth / atme / chat / search), `send` (dm / group / reply / chat), `edit`, `emoji`,
  `ding`, `todo`, `notify`, `anchors`, `consumers`, `follow`, `listen`, `pull`, `tick`, `probe`,
  `stream-status`, `health`, `ding-log`, `scan`, `topic`, `service`, `doctor`, `consume`.
- **Hub core**: anchors, dispatch with per-consumer cursors, rate limiting, degradation/recovery ladder,
  incremental scan, topics.
- **Consumers**: `session-follow` delivers subscribed conversations to any inbox via `DWS_HUB_INBOX_CMD`
  (falls back to `logs/inbox-skipped-*.jsonl` when unset — messages are never dropped).
- **Service**: `dws-hub service install|uninstall|status` for launchd (macOS) and systemd `--user` (Linux).
- **Generic-only gate**: `bun run check:generic` (structural rules + external denylist), also runs on `npm pack`.
- **Docs**: `docs/design.md`, an agent-facing `skills/dws-hub/SKILL.md`, and `SECURITY.md`.

### Notes

- Organization-specific integrations are out of scope: consumers are external commands, so such logic
  always lives in the consuming project.
