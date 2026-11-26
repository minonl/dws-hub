/**
 * 会话跟进订阅（hub/follows.mjs）单测
 * 设计：docs/design.md
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  addFollow,
  allScopes,
  emptyFollows,
  hasAtmeOnly,
  listFollows,
  loadFollows,
  removeFollow,
  saveFollows,
  sessionsForEvent,
  validateScope,
  validateSession,
} from './follows.mjs';

describe('session-follow / 注册表', () => {
  test('add：同一 (session, scope) 幂等更新，不重复', () => {
    const doc = emptyFollows();
    addFollow(doc, { session: 'ses_a', scope: 'group:g1', label: '示例群' });
    addFollow(doc, { session: 'ses_a', scope: 'group:g1', atmeOnly: true });
    const rows = listFollows(doc);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ session: 'ses_a', scope: 'group:g1', atme_only: true });
  });

  test('allScopes：只取启用会话的并集；hasAtmeOnly 只看启用项', () => {
    const doc = emptyFollows();
    addFollow(doc, { session: 'ses_a', scope: 'group:g1' });
    addFollow(doc, { session: 'ses_b', scope: 'direct:u1', atmeOnly: true });
    addFollow(doc, { session: 'ses_c', scope: 'group:g2' });
    doc.sessions.ses_c.enabled = false;
    expect(allScopes(doc)).toEqual(['direct:u1', 'group:g1']);
    expect(hasAtmeOnly(doc)).toBe(true);
    expect(hasAtmeOnly({ ...doc, sessions: { ses_a: doc.sessions.ses_a } })).toBe(false);
  });

  test('remove：按 scope / 整个会话', () => {
    const doc = emptyFollows();
    addFollow(doc, { session: 'ses_a', scope: 'group:g1' });
    addFollow(doc, { session: 'ses_a', scope: 'direct:u1' });
    expect(removeFollow(doc, { session: 'ses_a', scope: 'group:g1' }).removed).toBe(1);
    expect(listFollows(doc)).toHaveLength(1);
    expect(removeFollow(doc, { session: 'ses_a', all: true }).removed).toBe(1);
    expect(listFollows(doc)).toHaveLength(0);
  });

  test('load/save：原子落盘并可读回；损坏文件 → 空表 + 备份', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dws-hub-follows-'));
    try {
      const p = join(dir, 'session-follows.json');
      const doc = emptyFollows();
      addFollow(doc, { session: 'ses_a', scope: 'group:g1' });
      saveFollows(doc, p);
      expect(listFollows(loadFollows(p))).toHaveLength(1);
      writeFileSync(p, '{broken');
      expect(listFollows(loadFollows(p))).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('session-follow / 事件匹配', () => {
  const makeDoc = () => {
    const doc = emptyFollows();
    addFollow(doc, { session: 'ses_a', scope: 'group:g1', label: '示例群' });
    addFollow(doc, { session: 'ses_b', scope: 'direct:u1', atmeOnly: true });
    return doc;
  };

  test('按 scope 精确匹配；无关 scope 不投递', () => {
    const doc = makeDoc();
    const ev = { ext_id: 'm1', scope: 'group:g1', text: 'hi', at: '2026-11-13T03:00:00Z' };
    expect(sessionsForEvent(doc, ev).map((h) => h.session)).toEqual(['ses_a']);
    expect(sessionsForEvent(doc, { ...ev, scope: 'group:g2' })).toEqual([]);
  });

  test('atme_only 只投 @我；outbound / aiSendFlag 一律不投（防自激）', () => {
    const doc = makeDoc();
    const base = { ext_id: 'm2', scope: 'direct:u1', text: 'hi', at: '2026-11-13T03:00:00Z' };
    expect(sessionsForEvent(doc, base)).toEqual([]);
    expect(sessionsForEvent(doc, { ...base, meta: { mentionMe: true } }).map((h) => h.session)).toEqual(['ses_b']);
    expect(sessionsForEvent(doc, { ...base, meta: { mentionMe: true }, outbound: true })).toEqual([]);
    expect(sessionsForEvent(doc, { ...base, meta: { mentionMe: true, aiSendFlag: '1' } })).toEqual([]);
  });
});

describe('session-follow / 校验', () => {
  test('session / scope 形态', () => {
    expect(validateSession('ses_abc')).toBe('ses_abc');
    expect(() => validateSession('abc')).toThrow('E_SESSION');
    expect(validateScope('group:cidTESTgroup0001')).toBe(
      'group:cidTESTgroup0001',
    );
    expect(validateScope('direct:123')).toBe('direct:123');
    expect(() => validateScope('dm:123')).toThrow('E_SCOPE');
  });
});
