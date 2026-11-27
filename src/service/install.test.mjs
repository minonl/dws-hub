/**
 * 服务安装：环境变量透传 + 稳定 launcher（不写死 bun）
 */
import { describe, expect, test } from 'bun:test';
import { plist, serviceEnv, systemdUnit } from './install.mjs';

const env = {
  DWS_HUB_DB: '/data/hub.db',
  DWS_HUB_FOLLOWS: '/data/consumers/session-follows.json',
  DWS_HUB_INBOX_CMD: 'inbox add --key "$DWS_HUB_INBOX_KEY"',
  DWS_HUB_SELF_USER: 'u1',
  PATH: '/usr/bin',
  HOME: '/Users/example',
};

const launcher = '/root/bin/dws-hub-service';

describe('service install', () => {
  test('serviceEnv 只收 DWS_HUB_* 并强制 HOME/ENABLE', () => {
    const out = serviceEnv('/root', env);
    expect(out.DWS_HUB_DB).toBe('/data/hub.db');
    expect(out.DWS_HUB_INBOX_CMD).toContain('DWS_HUB_INBOX_KEY');
    expect(out.DWS_HUB_HOME).toBe('/root');
    expect(out.DWS_HUB_ENABLE).toBe('1');
    expect(out.PATH).toBeUndefined();
    expect(out.HOME).toBeUndefined();
  });

  test('plist 走稳定 launcher，不写死 bun', () => {
    const p = plist({ launcher, root: '/root', env });
    expect(p).toContain('<string>/bin/bash</string>');
    expect(p).toContain(`<string>${launcher}</string>`);
    expect(p).not.toMatch(/Cellar|\.bun\//);
    expect(p).toContain('<key>X-DwsHub-Owned</key><true/>');
    expect(p).toContain('<key>DWS_HUB_DB</key><string>/data/hub.db</string>');
    expect(p).not.toContain('<key>PATH</key>');
  });

  test('systemd unit 走同一条 launcher，并带归属标记', () => {
    const u = systemdUnit({ launcher, root: '/root', env });
    expect(u).toContain(`ExecStart=/bin/bash ${launcher}`);
    expect(u).toContain('X-DwsHub-Owned=1');
    expect(u).toContain('Environment=DWS_HUB_DB=/data/hub.db');
    expect(u).not.toContain('Environment=PATH=');
  });
});
