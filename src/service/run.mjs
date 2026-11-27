#!/usr/bin/env bun
/**
 * 常驻服务的实际执行体（由 launchd / systemd 调起）。
 *
 * 设计要点：
 * - **有界长连接 + 循环**：`listen` 每次有界（默认 1500s），到期重连；常驻由服务管理器 KeepAlive 保证。
 * - **单实例**：跨数据根固定锁（见 service/lock.mjs），双实例会互相抢订阅。
 * - **启动自检**：`dws` 不可执行就大声退出，绝不静默当成「0 条消息」（历史事故）。
 * - **日志轮转**：按天写 `logs/service-YYYY-MM-DD.log`，启动时清理 14 天前的文件。
 * - **版本可见**：包版本写进锁的 meta，`dws-hub doctor` 据此判断「跑的是不是刚装的版本」。
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dataRoot } from '../config.mjs';
import { acquireLock } from './lock.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'cli.mjs');
const PKG = JSON.parse(readFileSync(join(HERE, '..', '..', 'package.json'), 'utf8'));

const root = dataRoot();
const logs = join(root, 'logs');
mkdirSync(logs, { recursive: true });

// ── 按天日志 + 保留 14 天 ───────────────────────────────────────────────────
const LOG_KEEP_DAYS = Math.max(1, Number(process.env.DWS_HUB_LOG_KEEP_DAYS) || 14);
const day = new Date().toISOString().slice(0, 10);
const logFile = join(logs, `service-${day}.log`);
const logFd = openSync(logFile, 'a');
try {
  const cutoff = Date.now() - LOG_KEEP_DAYS * 86400e3;
  for (const f of readdirSync(logs)) {
    const m = /^service-(\d{4}-\d{2}-\d{2})\.log$/.exec(f);
    if (!m) continue;
    const t = Date.parse(`${m[1]}T00:00:00Z`);
    if (Number.isFinite(t) && t < cutoff) rmSync(join(logs, f), { force: true });
  }
} catch {
  /* 清理失败不影响启动 */
}

function write(s) {
  try {
    writeSync(logFd, s);
  } catch {
    /* 日志写失败不阻塞服务 */
  }
  process.stdout.write(s);
}
function log(msg) {
  write(`[dws-hub] ${new Date().toISOString()} ${msg}\n`);
}

// ── 单实例锁（跨数据根，唯一路径见 service/lock.mjs）────────────────────────
let lock;
try {
  lock = acquireLock({ role: 'service', version: PKG.version });
} catch (e) {
  if (e?.code === 'E_LOCKED') {
    log(`✗ ${e.message}`);
    process.exit(3);
  }
  throw e;
}
if (lock.reclaimed) log('接管陈旧锁（上一个实例的 pid 已不在）');
log(`启动 service v${PKG.version} · 锁 ${lock.path} · 日志 ${logFile}`);

function cleanup() {
  try {
    lock.release();
  } catch {
    /* noop */
  }
}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    log(`收到 ${sig}，退出`);
    cleanup();
    process.exit(0);
  });
}

// ── dws 自检 ────────────────────────────────────────────────────────────────
// launchd / systemd 的 PATH 极简（/usr/bin:/bin），既找不到 dws，也找不到 dws 需要的 node。
function resolveDws() {
  const cands = [process.env.DWS_BIN];
  try {
    const viaShell = execFileSync('/bin/sh', ['-c', 'command -v dws'], { encoding: 'utf8', timeout: 5000 })
      .trim()
      .split('\n')[0];
    if (viaShell) cands.push(viaShell);
  } catch {
    /* ignore */
  }
  cands.push(
    join(homedir(), '.local/share/fnm/aliases/default/bin/dws'),
    join(homedir(), '.local/bin/dws'),
    '/opt/homebrew/bin/dws',
    '/usr/local/bin/dws',
  );
  for (const dir of [join(homedir(), '.local/state/fnm_multishells'), join(homedir(), '.nvm/versions/node')]) {
    try {
      for (const e of readdirSync(dir)) cands.push(join(dir, e, 'bin/dws'));
    } catch {
      /* 目录不存在 */
    }
  }
  for (const c of cands.filter(Boolean)) {
    const dir = dirname(c);
    try {
      execFileSync(c, ['--version'], {
        stdio: 'ignore',
        timeout: 5000,
        env: { ...process.env, PATH: `${dir}:${process.env.PATH || '/usr/bin:/bin'}` },
      });
      return c;
    } catch {
      /* try next */
    }
  }
  return null;
}

const dwsBin = resolveDws();
if (!dwsBin) {
  log('✗ 找不到可执行的 dws（设置 DWS_BIN 或把它装到 PATH）——注意 dws 是 Node 脚本，还需要 node');
  process.exit(3);
}
process.env.DWS_BIN = dwsBin;
process.env.PATH = `${dirname(dwsBin)}:${process.env.PATH || '/usr/bin:/bin'}`;
log(`dws 自检通过：${dwsBin}`);
run();

function run() {
  const args = [
    CLI,
    'listen',
    '--interval', process.env.DWS_HUB_INTERVAL || '60',
    '--stream-sec', process.env.DWS_HUB_STREAM_SEC || '1500',
  ];
  log(`启动监听（数据根 ${root}）`);
  const child = spawn(process.execPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DWS_HUB_SKIP_LOCK: '1' }, // 锁由 service 持有，listen 子进程不再抢
  });
  child.stdout.on('data', (d) => write(d.toString()));
  child.stderr.on('data', (d) => {
    try {
      writeSync(logFd, d);
    } catch {
      /* noop */
    }
    process.stderr.write(d);
  });
  child.on('close', (code) => {
    log(`listen 退出 code=${code}`);
    cleanup();
    process.exit(code ?? 0);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      log(`转发 ${sig} 给监听子进程`);
      child.kill(sig);
    });
  }
}
