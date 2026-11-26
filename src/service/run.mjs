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
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const dwsBin = process.env.DWS_BIN || 'dws';
const probe = spawn(dwsBin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
let probeOut = '';
probe.stdout.on('data', (c) => (probeOut += c));
probe.on('close', (code) => {
  if (code !== 0) {
    log(`✗ dws 不可执行（${dwsBin}）——常见原因：PATH 缺 node（dws 是 Node 脚本）；先修 PATH 再启动`);
    process.exit(3);
  }
  log(`dws 自检通过：${probeOut.trim().split('\n')[0]}`);
  run();
});

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
