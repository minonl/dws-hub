#!/usr/bin/env bun
/**
 * 常驻服务的实际执行体（由 launchd / systemd 调起）。
 *
 * 设计要点：
 * - **有界长连接 + 循环**：`listen` 每次有界（默认 1500s），到期重连；常驻由服务管理器 KeepAlive 保证。
 *   不用「无限期监听」，避免不可控的野生进程。
 * - **单实例**：`mkdir` 原子锁（`<root>/run/dws-hub.lock`），双实例会互相抢订阅。
 * - **启动自检**：`dws` 不可执行就大声退出，绝不静默当成「0 条消息」（历史事故）。
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dataRoot } from '../config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'cli.mjs');

const root = dataRoot();
const lock = join(root, 'run', 'dws-hub.lock');
const logs = join(root, 'logs');
mkdirSync(dirname(lock), { recursive: true });
mkdirSync(logs, { recursive: true });

function log(msg) {
  console.log(`[dws-hub] ${new Date().toISOString()} ${msg}`);
}

// ── 单实例锁 ────────────────────────────────────────────────────────────────
try {
  mkdirSync(lock);
  writeFileSync(join(lock, 'pid'), String(process.pid));
} catch {
  const owner = Number(readFileSync(join(lock, 'pid'), 'utf8').trim() || 0);
  const alive = owner > 0 && (() => {
    try {
      process.kill(owner, 0);
      return true;
    } catch {
      return false;
    }
  })();
  if (alive) {
    log(`已有实例在跑（pid=${owner}）→ 退出，避免双实例`);
    process.exit(0);
  }
  log(`发现陈旧锁（pid=${owner} 已不在）→ 接管`);
  rmSync(lock, { recursive: true, force: true });
  mkdirSync(lock);
  writeFileSync(join(lock, 'pid'), String(process.pid));
}

function cleanup() {
  try {
    rmSync(lock, { recursive: true, force: true });
  } catch {
    /* 清理失败不阻塞退出 */
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
// 先按「显式 → 登录 shell 解析 → 常见安装位置」找绝对路径，再把它的目录塞进 PATH。
function resolveDws() {
  const cands = [process.env.DWS_BIN];
  try {
    const viaShell = execFileSync('/bin/sh', ['-lc', 'command -v dws'], { encoding: 'utf8', timeout: 5000 })
      .trim()
      .split('\n')[0];
    if (viaShell) cands.push(viaShell);
  } catch {
    /* 登录 shell 不可用就继续用候选列表 */
  }
  cands.push('/opt/homebrew/bin/dws', '/usr/local/bin/dws', join(homedir(), '.local/bin/dws'));
  for (const c of cands.filter(Boolean)) {
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore', timeout: 5000 });
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
  log(`启动监听：bun ${args.join(' ')}（数据根 ${root}）`);
  const child = spawn(process.execPath, args, { stdio: 'inherit' });
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
