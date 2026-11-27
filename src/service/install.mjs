/**
 * 服务安装 / 卸载 / 状态（macOS=launchd，Linux=systemd --user）
 *
 * 与旧实现的关键差别：**不依赖任何外部框架解析「哪份代码生效」**。
 * 注册入口是一个稳定 launcher（`<root>/bin/dws-hub-service`），**在运行时探测 bun**，
 * 所以 bun 升级/换路径（Homebrew Cellar、fnm、nvm）不会让服务失效；plist 里不写死 bun。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
export const launcherPath = (root) => join(root, 'bin', 'dws-hub-service');

/** 生成稳定 launcher：运行时找 bun（PATH → 常见位置），找不到就大声失败。 */
export function writeLauncher(root, env = process.env) {
  const file = launcherPath(root);
  mkdirSync(dirname(file), { recursive: true });
  const script = `#!/bin/bash
# 稳定入口（勿手改）：由 dws-hub service install 生成。
# 为什么不写死 bun：Homebrew 升级会删旧 Cellar 版本目录；fnm/nvm 也会换路径。
set -u
export PATH="\${DWS_HUB_PATH_PREFIX:-/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.local/share/fnm/aliases/default/bin}:$PATH"
BUN="\${DWS_HUB_BUN:-}"
if [ -z "$BUN" ]; then BUN="$(command -v bun 2>/dev/null || true)"; fi
if [ -z "$BUN" ]; then
  for c in "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do
    [ -x "$c" ] && BUN="$c" && break
  done
fi
[ -n "$BUN" ] || { echo "[dws-hub] ✗ 找不到 bun（设置 DWS_HUB_BUN 或把 bun 加入 PATH）" >&2; exit 3; }
exec "$BUN" ${JSON.stringify(join(HERE, 'run.mjs'))}
`;
  writeFileSync(file, script, { mode: 0o755 });
  return file;
}

const isMac = platform() === 'darwin';
const launchAgentPath = () => join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const systemdUnitPath = () => join(homedir(), '.config', 'systemd', 'user', 'dws-hub.service');

export function plist({ launcher, root, env = process.env }) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const vars = serviceEnv(root, env);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>X-DwsHub-Owned</key><true/>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${esc(launcher)}</string>
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
  <key>StandardOutPath</key><string>${esc(join(root, 'logs', 'launcher.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(join(root, 'logs', 'launcher.log'))}</string>
</dict>
</plist>
`;
}

export function systemdUnit({ launcher, root, env = process.env }) {
  return `[Unit]
Description=dws-hub (DingTalk workspace CLI capability layer)
After=network-online.target

[Service]
X-DwsHub-Owned=1
Type=simple
ExecStart=/bin/bash ${launcher}
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

/** 解析 bun：优先 PATH 里的稳定入口，避免把 Homebrew Cellar 版本目录钉进 plist（升级后路径会消失）。 */
export function resolveBun(env = process.env) {
  try {
    const p = execFileSync('/bin/sh', ['-c', 'command -v bun'], { encoding: 'utf8', timeout: 5000, env })
      .trim()
      .split('\n')[0];
    if (p && !/\/Cellar\//.test(p)) return p;
  } catch {
    /* fall through */
  }
  return process.execPath;
}

/** 读现有服务单元里的 EnvironmentVariables（重装时作为默认值，避免少传一个变量就丢配置）。 */
export function readUnitEnv() {
  try {
    if (isMac) {
      const j = JSON.parse(
        execFileSync('plutil', ['-convert', 'json', '-o', '-', launchAgentPath()], { encoding: 'utf8' }),
      );
      return j.EnvironmentVariables || {};
    }
    const env = {};
    for (const line of readFileSync(systemdUnitPath(), 'utf8').split('\n')) {
      const m = /^Environment=([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
      if (m) env[m[1]] = m[2];
    }
    return env;
  } catch {
    return {};
  }
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** 等 label 真正从 launchd 消失（bootout 是异步的，紧接着 bootstrap 会偶发 EIO）。 */
function waitUnloaded(domain, label, tries = 20) {
  for (let i = 0; i < tries; i += 1) {
    try {
      sh('launchctl', ['print', `${domain}/${label}`]);
      sleepSync(100);
    } catch {
      return true;
    }
  }
  return false;
}

function bootstrapRetry(domain, file, label, tries = 5) {
  let lastErr;
  for (let i = 0; i < tries; i += 1) {
    try {
      sh('launchctl', ['bootstrap', domain, file]);
      return;
    } catch (e) {
      lastErr = e;
      // 已存在（另一实例刚起来）也算成功
      try {
        sh('launchctl', ['print', `${domain}/${label}`]);
        return;
      } catch {
        sleepSync(300);
      }
    }
  }
  throw lastErr || new Error('bootstrap failed');
}

export function install() {
  const root = dataRoot();
  mkdirSync(join(root, 'logs'), { recursive: true });
  const launcher = writeLauncher(root, process.env);
  // 已有单元 env 作为默认值：这次 shell 没传的变量保持原值
  const mergedEnv = { ...readUnitEnv(), ...process.env };
  const args = { launcher, root, env: mergedEnv };

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
    waitUnloaded(domain, LABEL);
    bootstrapRetry(domain, file, LABEL);
    sh('launchctl', ['enable', `${domain}/${LABEL}`]);
    sh('launchctl', ['kickstart', '-k', `${domain}/${LABEL}`]);
    return { platform: 'launchd', label: LABEL, file, launcher, entry: RUN_ENTRY, root };
  }

  const file = systemdUnitPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, systemdUnit({ ...args, env: mergedEnv }));
  sh('systemctl', ['--user', 'daemon-reload']);
  sh('systemctl', ['--user', 'enable', '--now', 'dws-hub.service']);

  // 登出后 systemd --user 会停：必须开 linger（否则「看起来装好了，一登出就没了」）
  let linger = 'unknown';
  try {
    linger = sh('loginctl', ['show-user', process.env.USER || '', '-p', 'Linger']).trim();
  } catch {
    /* loginctl 不可用 */
  }
  const lingerOk = /Linger=yes/.test(linger);
  return {
    platform: 'systemd',
    label: 'dws-hub.service',
    file,
    launcher,
    entry: RUN_ENTRY,
    root,
    linger: lingerOk ? 'yes' : 'no',
    ...(lingerOk ? {} : { warning: '未开启 linger：登出后会停服。执行 loginctl enable-linger $USER' }),
  };
}

/** 还有哪些注册看起来也在跑 dws-hub（卸载后提示用） */
export function findOtherRegistrations() {
  const out = [];
  if (isMac) {
    try {
      const list = execFileSync('launchctl', ['list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      for (const line of list.split('\n')) {
        const label = (line.split('\t')[2] || '').trim();
        if (!label || label === LABEL) continue;
        if (/dws[-_]hub/i.test(label)) out.push(label);
      }
    } catch {
      /* ignore */
    }
    return out;
  }
  try {
    const files = execFileSync('systemctl', ['--user', 'list-unit-files', '*dws-hub*', '--no-legend'], {
      encoding: 'utf8',
    });
    for (const line of files.split('\n').filter(Boolean)) {
      const name = line.split(/\s+/)[0];
      if (name && name !== 'dws-hub.service') out.push(name);
    }
  } catch {
    /* ignore */
  }
  return out;
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
    const resurrectors = findOtherRegistrations();
    return {
      platform: 'launchd',
      removed: existed,
      already_absent: !existed,
      ...(resurrectors.length ? { possible_resurrectors: resurrectors } : {}),
    };
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
  const resurrectors = findOtherRegistrations();
  return {
    platform: 'systemd',
    removed: existed,
    already_absent: !existed,
    ...(resurrectors.length ? { possible_resurrectors: resurrectors } : {}),
  };
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
