# Changelog

All notable changes to this project are documented here.

## [0.1.5] — 2026-11-26

### Fixed

- `direct:` scopes whose id is an openDingTalkId now use `--open-dingtalk-id` (poll and event stream).
  Passing an open id to `--user` made `dws` fail with `peerUid is required`, so direct conversations
  never polled.

## [0.1.4] — 2026-11-26

### Fixed

- The supervised runner now resolves `dws` to an absolute path (explicit `DWS_BIN` → login shell
  lookup → common install locations) and prepends its directory to `PATH`. launchd/systemd start with
  a minimal `PATH`, so the service previously failed with `Executable not found in $PATH: "dws"`.
- `service install` records the resolved `DWS_BIN` in the generated unit/plist.

## [0.1.3] — 2026-11-26

### Fixed

- `service install` now passes through all `DWS_HUB_*` environment variables (database, follow
  registry, inbox command, self identity) into the generated launchd plist / systemd unit.
  Previously only home/enable/interval/stream were written, so a supervised install could not see
  an existing database or delivery command.

## [0.1.2] — 2026-11-26

### Fixed

- Republish to work around a CDN edge issue that cached a pre-replication 404 for the
  `0.1.1` tarball. Package contents are identical apart from the version.

## [0.1.1] — 2026-11-26

### Changed

- First release published from CI via **npm Trusted Publishing (OIDC)** with provenance.

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
