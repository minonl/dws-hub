/**
 * 跨数据根单实例锁（唯一实现）
 *
 * 为什么锁**不放在数据根下**：不同 `DWS_HUB_HOME` 会得到不同的锁文件，
 * 于是"单实例"只对同一份配置成立——`<旧根>/run` 与 `<新根>/run` 就是两把锁，
 * 新旧服务并行了几小时才发现（2026-11-27 事故）。
 *
 * 位置（跨平台一致，与数据根无关）：`~/.dws-hub/run/dws-hub.lock`
 *   —— 家目录下的固定隐藏目录，macOS / Linux / WSL 同一路径；
 *   数据根（DWS_HUB_HOME）可以不同，但锁始终是这一个。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { dataRoot } from '../config.mjs';

export function lockPath(env = process.env) {
  if (env.DWS_HUB_LOCK) return env.DWS_HUB_LOCK;
  return join(homedir(), '.dws-hub', 'run', 'dws-hub.lock');
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readMeta(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 获取单实例锁。
 * @returns {{ path: string, release: () => void, reclaimed: boolean }}
 * @throws 已有活实例时抛出 `{ code: 'E_LOCKED', pid, root, since }` 的错误
 */
export function acquireLock({ env = process.env, role = 'service', version = null } = {}) {
  const path = lockPath(env);
  const root = dataRoot(env);
  mkdirSync(dirname(path), { recursive: true });

  const take = () => {
    mkdirSync(path);
    writeFileSync(
      join(path, 'meta.json'),
      JSON.stringify({ pid: process.pid, root, role, version, since: new Date().toISOString() }, null, 2),
    );
  };

  let reclaimed = false;
  try {
    take();
  } catch {
    const meta = readMeta(path);
    if (meta && pidAlive(Number(meta.pid))) {
      const e = new Error(
        `已有 dws-hub 实例在跑（pid=${meta.pid}, root=${meta.root}, role=${meta.role || '?'}）；` +
          `如要手动调试，先 dws-hub service uninstall`,
      );
      e.code = 'E_LOCKED';
      e.pid = meta.pid;
      e.root = meta.root;
      e.since = meta.since;
      throw e;
    }
    // 陈旧锁（pid 已不在）→ 接管
    rmSync(path, { recursive: true, force: true });
    take();
    reclaimed = true;
  }

  const release = () => {
    const meta = readMeta(path);
    if (!meta || Number(meta.pid) !== process.pid) return; // 不是自己的锁，别删
    rmSync(path, { recursive: true, force: true });
  };

  return { path, release, reclaimed };
}
