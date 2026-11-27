/**
 * `dws-hub doctor` —— 环境自检（只读）
 *
 * 目的：把「看起来在跑其实没投递」「注册路径指向旧安装」这类静默故障提前暴露。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dataRoot, dbPath, ENV, followsPath } from './config.mjs';
import { RUN_ENTRY, launcherPath, status as serviceStatus } from './service/install.mjs';
import { lockPath } from './service/lock.mjs';

const PKG = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));

/** 读「服务单元」里的环境变量（SSOT：服务实际生效的那份，而不是当前 shell）。 */
export function unitEnv() {
  if (process.platform === 'darwin') {
    const file = join(homedir(), 'Library', 'LaunchAgents', 'local.dws-hub.plist');
    if (!existsSync(file)) return null;
    try {
      const j = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }));
      return { file, env: j.EnvironmentVariables || {} };
    } catch {
      return { file, env: {} };
    }
  }
  const file = join(homedir(), '.config', 'systemd', 'user', 'dws-hub.service');
  if (!existsSync(file)) return null;
  const env = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^Environment=([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
  return { file, env };
}

/** 扫描机器上**所有**看起来在跑 dws-hub 的注册（不只是自己的 label）。 */
export function findRegistrations() {
  const out = [];
  if (process.platform === 'darwin') {
    try {
      const list = execFileSync('launchctl', ['list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      for (const line of list.split('\n')) {
        const parts = line.split('\t');
        const label = parts[2] || '';
        if (!/dws[-_]hub/i.test(label)) continue;
        let args = [];
        try {
          const p = execFileSync('plutil', ['-convert', 'json', '-o', '-', join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`)], { encoding: 'utf8' });
          args = JSON.parse(p).ProgramArguments || [];
        } catch {
          /* plist 可能不在本 HOME（历史/测试残留） */
        }
        out.push({ label, pid: parts[0], args: args.join(' ') });
      }
    } catch {
      /* launchctl 不可用 */
    }
    return out;
  }
  try {
    const files = execFileSync('systemctl', ['--user', 'list-unit-files', '*dws-hub*', '--no-legend'], { encoding: 'utf8' });
    for (const line of files.split('\n').filter(Boolean)) {
      const name = line.split(/\s+/)[0];
      out.push({ label: name, args: '' });
    }
  } catch {
    /* ignore */
  }
  return out;
}

function probe(bin, args) {
  try {
    const out = execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
    return { ok: true, out: out.trim().split('\n')[0] };
  } catch (e) {
    return { ok: false, error: String(e?.stderr || e?.message || e).trim().slice(0, 300) };
  }
}

export function doctor({ env = process.env } = {}) {
  const checks = [];
  // 服务单元是 SSOT：单元存在时，资源类检查按单元 env 合并（否则会检查"另一套配置"→ 假绿）
  const unitEarly = unitEnv();
  const eff = unitEarly ? { ...env, ...unitEarly.env } : env;
  const add = (id, ok, detail, fix) => checks.push({ id, ok, detail, ...(ok ? {} : { fix }) });

  // 1) bun：运行时 + PATH 里可解析（服务由 launcher 在运行时找 bun）
  const bun = globalThis.Bun?.version;
  const bunProbe = probe(env.DWS_HUB_BUN || 'bun', ['--version']);
  add(
    'bun',
    Boolean(bun) && bunProbe.ok,
    `${bun ? `runtime ${bun}` : 'runtime 缺失'} · ${bunProbe.ok ? bunProbe.out : 'PATH 中不可执行'}`,
    '安装 bun（或在服务环境里设置 DWS_HUB_BUN）',
  );

  // 2) dws
  const dws = probe(env.DWS_BIN || 'dws', ['--version']);
  add('dws', dws.ok, dws.ok ? dws.out : `不可执行：${dws.error}`, '安装 dws 并确保在 PATH（注意 dws 是 Node 脚本，需要 node）');

  // 3) dws 登录态
  try {
    const auth = execFileSync(env.DWS_BIN || 'dws', ['auth', 'status'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
    const authed = /authenticated|已登录|logged/i.test(auth) && !/not\s+logged|未登录/i.test(auth);
    add('auth', authed, authed ? '已登录' : auth.trim().slice(0, 120), 'dws auth login --device');
  } catch (e) {
    add('auth', false, `auth status 失败：${String(e?.stderr || e?.message).slice(0, 120)}`, 'dws auth login --device');
  }

  // 4) 数据根
  const root = dataRoot(eff);
  const tmpPrefixes = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders', tmpdir()].filter(Boolean);
  const ephemeral = tmpPrefixes.some((p) => root.startsWith(p.replace(/\/$/, '')));
  add('data-root', !ephemeral, root, '把 DWS_HUB_HOME 指到持久目录（系统临时目录重启即丢）');

  // 5) 库（不存在是正常状态：首次运行会创建）
  const db = dbPath(eff);
  add('db', true, existsSync(db) ? `${db}（${Math.round(statSync(db).size / 1024)} KB）` : `${db} 尚未创建（首次运行会创建）`);

  // 6) 投递命令
  const cmd = String(eff[ENV.inboxCmd] || '').trim();
  add('inbox', Boolean(cmd), cmd ? 'DWS_HUB_INBOX_CMD 已配置' : '未配置：消息只落 logs/inbox-skipped-*.jsonl', `设置 ${ENV.inboxCmd}（模板变量见 README）`);

  // 7) 订阅注册表
  const follows = followsPath(eff);
  add('follows', true, existsSync(follows) ? `${follows}` : `${follows} 不存在（无订阅）`);

  // 7.5) 服务单元的环境 vs 当前根（防「doctor 检查的不是活服务那套」的假绿）
  const unit = unitEnv();
  if (unit) {
    const unitRoot = unit.env.DWS_HUB_HOME;
    const explicitHome = env[ENV.home];
    const conflict = Boolean(explicitHome && unitRoot && explicitHome !== unitRoot);
    add(
      'root-consistency',
      !conflict,
      unitRoot ? `unit=${unitRoot}${explicitHome ? ` vs env=${explicitHome}` : '（未显式设置 env，以单元为准）'}` : 'unit 未声明 DWS_HUB_HOME',
      `用同一套 env 重装：DWS_HUB_HOME=${unitRoot} dws-hub service install`,
    );
  }

  // 7.6) 重复注册（不同 label 但都在跑 dws-hub）
  const regs = findRegistrations();
  add(
    'duplicate-registration',
    regs.length <= 1,
    regs.length ? regs.map((r) => r.label).join(', ') : '无',
    '停掉并卸载多余的注册（dws-hub service uninstall / 旧 dia-job 卸载）',
  );

  // 7.8) launcher 与运行版本
  const launcher = launcherPath(root);
  add('launcher', existsSync(launcher), existsSync(launcher) ? launcher : `${launcher} 不存在（dws-hub service install）`, 'dws-hub service install');
  let runningVersion = null;
  try {
    runningVersion = JSON.parse(readFileSync(join(lockPath(env), 'meta.json'), 'utf8')).version || null;
  } catch {
    runningVersion = null;
  }
  if (runningVersion) {
    add(
      'running-version',
      runningVersion === PKG.version,
      `running=${runningVersion} package=${PKG.version}`,
      '升级后需重启服务：dws-hub service install',
    );
  }

  // 8) 服务
  const svc = serviceStatus();
  const entryDrift = svc.entry !== RUN_ENTRY;
  if (svc.platform === 'launchd') {
    add('service', svc.loaded && !entryDrift, `launchd ${svc.label} loaded=${svc.loaded}${entryDrift ? `；注册入口=${svc.entry} ≠ 当前=${RUN_ENTRY}` : ''}`, entryDrift ? 'dws-hub service install' : 'dws-hub service install');
  } else {
    add('service', svc.active === 'active', `systemd ${svc.label} active=${svc.active || 'unknown'}`, 'dws-hub service install');
  }

  const ok = checks.every((c) => c.ok);
  return { ok, data_root: root, checks };
}
