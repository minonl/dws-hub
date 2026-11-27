/**
 * 单实例锁：**跨数据根**也必须互斥（锁路径与 DWS_HUB_HOME 无关）
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { acquireLock, lockPath } from './lock.mjs';

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'dws-hub-lock-'));
  return { dir, env: { DWS_HUB_LOCK: join(dir, 'lock'), DWS_HUB_HOME: join(dir, 'root-a') } };
}

describe('service lock', () => {
  test('同一把锁：不同 DWS_HUB_HOME 也互斥', () => {
    const s = sandbox();
    try {
      const first = acquireLock({ env: s.env, role: 'test' });
      let err = null;
      try {
        acquireLock({ env: { ...s.env, DWS_HUB_HOME: join(s.dir, 'root-b') }, role: 'test' });
      } catch (e) {
        err = e;
      }
      expect(err?.code).toBe('E_LOCKED');
      first.release();
    } finally {
      rmSync(s.dir, { recursive: true, force: true });
    }
  });

  test('释放后可再次获取', () => {
    const s = sandbox();
    try {
      const a = acquireLock({ env: s.env, role: 'test' });
      a.release();
      const b = acquireLock({ env: s.env, role: 'test' });
      expect(b.reclaimed).toBe(false);
      b.release();
    } finally {
      rmSync(s.dir, { recursive: true, force: true });
    }
  });

  test('锁路径与数据根无关（默认隐藏目录）', () => {
    const p1 = lockPath({});
    const p2 = lockPath({ DWS_HUB_HOME: '/somewhere/else' });
    expect(p1).toBe(p2);
    expect(p1.endsWith('/.dws-hub/run/dws-hub.lock')).toBe(true);
  });
});
