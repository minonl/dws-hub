# Changelog

All notable changes to this project are documented here.

## [0.1.7] — 2026-11-27

### Fixed

- **Cross-root single instance**: the lock now lives at a fixed `~/.dws-hub/run/dws-hub.lock`
  (overridable via `DWS_HUB_LOCK`) instead of under `DWS_HUB_HOME`. Two installs with different data
  roots previously held two different locks and could run side by side.
- `listen` now takes the same lock (the supervised child is exempted via `DWS_HUB_SKIP_LOCK=1`) and
  exits `3` with the owner pid instead of silently duplicating subscriptions.
- `service install` resolves `bun` from `PATH` (not the versioned Homebrew Cellar path) and marks the
  generated plist/unit with `X-DwsHub-Owned`.
- `doctor` gained two checks: `root-consistency` (unit `DWS_HUB_HOME` vs current process) and
  `duplicate-registration` (any other launchd label / systemd unit that looks like dws-hub).

## [0.1.6] — 2026-11-26

### Fixed

- The generated `session-follow` wrapper now adds common bin directories to `PATH` and falls back to
  an absolute Bun path. Under launchd/systemd the previous wrapper could not find `bun`, so the
  consumer exited non-zero and events were never acknowledged.

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
