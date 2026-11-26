/**
 * 服务安装 / 卸载 / 状态（macOS=launchd，Linux=systemd --user）
 *
 * 与旧实现的关键差别：**不依赖任何外部框架解析「哪份代码生效」**——
 * plist / unit 里直接写本包内 `service/run.mjs` 的绝对路径（安装时解析）。
 * 升级包后若路径变了，`dws-hub doctor` 会报「注册路径与当前安装不一致」并给重装命令。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dataRoot } from '../config.mjs';

export const LABEL = 'local.dws-hub';

/** 服务里需要生效的 DWS_HUB_* 环境变量（安装时从当前 shell 透传，避免服务起来读不到库/订阅）。 */
export function serviceEnv(root, env = process.env) {
  const out = {};
  // launchd/systemd 的 PATH 极简：把 dws 的绝对路径一起写进去，否则服务里找不到它
  if (!env.DWS_BIN) {
    // 安装时是从用户 shell 里跑的，PATH 完整：用非登录 shell 取实际路径即可
    try {
      const found = execFileSync('/bin/sh', ['-c', 'command -v dws'], {
        encoding: 'utf8',
        timeout: 5000,
        env,
      })
        .trim()
        .split('\n')[0];
      if (found) out.DWS_BIN = found;
    } catch {
      /* 解析失败就交给运行时再找 */
    }
  }
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith('DWS_HUB_')) continue;
    if (v === undefined || v === null || v === '') continue;
    out[k] = String(v);
  }
  out.DWS_HUB_HOME = root;
  out.DWS_HUB_ENABLE = '1';
  return out;
}
const HERE = dirname(fileURLToPath(import.meta.url));
export const RUN_ENTRY = join(HERE, 'run.mjs');

const isMac = platform() === 'darwin';
const launchAgentPath = () => join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const systemdUnitPath = () => join(homedir(), '.config', 'systemd', 'user', 'dws-hub.service');

export function plist({ bun, entry, root, env = process.env }) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const vars = serviceEnv(root, env);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(bun)}</string>
    <string>${esc(entry)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries({ DWS_HUB_INTERVAL: '60', DWS_HUB_STREAM_SEC: '1500', ...vars })
  .map(([k, v]) => `    <key>${esc(k)}</key><string>${esc(v)}</string>`)
  .join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${esc(join(root, 'logs', 'service.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(join(root, 'logs', 'service.log'))}</string>
</dict>
</plist>
`;
}

export function systemdUnit({ bun, entry, root, env = process.env }) {
  return `[Unit]
Description=dws-hub (DingTalk workspace CLI capability layer)
After=network-online.target

[Service]
Type=simple
ExecStart=${bun} ${entry}
${Object.entries({ DWS_HUB_INTERVAL: '60', DWS_HUB_STREAM_SEC: '1500', ...serviceEnv(root, env) })
  .map(([k, v]) => `Environment=${k}=${v}`)
  .join('\n')}
Restart=always
RestartSec=30

[Install]
WantedBy=default.target
`;
}

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function macLoaded() {
  try {
    sh('launchctl', ['print', `gui/${process.getuid()}/${LABEL}`]);
    return true;
  } catch {
    return false;
  }
}

export function install() {
  const root = dataRoot();
  mkdirSync(join(root, 'logs'), { recursive: true });
  const args = { bun: process.execPath, entry: RUN_ENTRY, root, env: process.env };

  if (isMac) {
    const file = launchAgentPath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, plist(args));
    const domain = `gui/${process.getuid()}`;
    try {
      sh('launchctl', ['bootout', `${domain}/${LABEL}`]);
    } catch {
      /* 未加载是正常情况 */
    }
    sh('launchctl', ['bootstrap', domain, file]);
    sh('launchctl', ['enable', `${domain}/${LABEL}`]);
    sh('launchctl', ['kickstart', '-k', `${domain}/${LABEL}`]);
    return { platform: 'launchd', label: LABEL, file, entry: RUN_ENTRY, root };
  }

  const file = systemdUnitPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, systemdUnit(args));
  sh('systemctl', ['--user', 'daemon-reload']);
  sh('systemctl', ['--user', 'enable', '--now', 'dws-hub.service']);
  return { platform: 'systemd', label: 'dws-hub.service', file, entry: RUN_ENTRY, root };
}

export function uninstall() {
  if (isMac) {
    try {
      sh('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`]);
    } catch {
      /* 未加载 */
    }
    const existed = existsSync(launchAgentPath());
    rmSync(launchAgentPath(), { force: true });
    return { platform: 'launchd', removed: existed, already_absent: !existed };
  }
  try {
    sh('systemctl', ['--user', 'disable', '--now', 'dws-hub.service']);
  } catch {
    /* 未安装 */
  }
  const existed = existsSync(systemdUnitPath());
  rmSync(systemdUnitPath(), { force: true });
  try {
    sh('systemctl', ['--user', 'daemon-reload']);
  } catch {
    /* ignore */
  }
  return { platform: 'systemd', removed: existed, already_absent: !existed };
}

export function status() {
  const root = dataRoot();
  if (isMac) {
    let loaded = false;
    try {
      loaded = macLoaded();
    } catch {
      loaded = false;
    }
    return { platform: 'launchd', label: LABEL, loaded, file: launchAgentPath(), root, entry: RUN_ENTRY };
  }
  let active = '';
  try {
    active = sh('systemctl', ['--user', 'is-active', 'dws-hub.service']).trim();
  } catch (e) {
    active = String(e?.stdout || '').trim() || 'inactive';
  }
  return { platform: 'systemd', label: 'dws-hub.service', active, file: systemdUnitPath(), root, entry: RUN_ENTRY };
}
