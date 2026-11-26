/**
 * 服务安装：环境变量透传（plist / systemd 都要带上库、订阅、投递命令等）
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

describe('service install env passthrough', () => {
  test('serviceEnv 只收 DWS_HUB_* 并强制 HOME/ENABLE', () => {
    const out = serviceEnv('/root', env);
    expect(out.DWS_HUB_DB).toBe('/data/hub.db');
    expect(out.DWS_HUB_INBOX_CMD).toContain('DWS_HUB_INBOX_KEY');
    expect(out.DWS_HUB_HOME).toBe('/root');
    expect(out.DWS_HUB_ENABLE).toBe('1');
    expect(out.PATH).toBeUndefined();
    expect(out.HOME).toBeUndefined();
  });

  test('plist 含关键变量且转义', () => {
    const p = plist({ bun: '/b/bun', entry: '/b/run.mjs', root: '/root', env });
    expect(p).toContain('<key>DWS_HUB_DB</key><string>/data/hub.db</string>');
    expect(p).toContain('<key>DWS_HUB_FOLLOWS</key>');
    expect(p).toContain('DWS_HUB_INBOX_KEY');
    expect(p).not.toContain('<key>PATH</key>');
  });

  test('systemd unit 含同样变量', () => {
    const u = systemdUnit({ bun: '/b/bun', entry: '/b/run.mjs', root: '/root', env });
    expect(u).toContain('Environment=DWS_HUB_DB=/data/hub.db');
    expect(u).toContain('Environment=DWS_HUB_HOME=/root');
    expect(u).not.toContain('Environment=PATH=');
  });
});
