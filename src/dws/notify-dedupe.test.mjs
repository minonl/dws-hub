/**
 * notify 去重单测：键稳定性 / 通道窗口 / 旁路容错
 *
 * 背景：调用方每轮都 notify 同一条告警 → 刷出一串重复的待办/消息。
 * 去重是 hub 层强制，`force` 也不绕过。
 *
 * 跑法：`bun test src/dws/notify-dedupe.test.mjs`
 */
import { describe, expect, test } from 'bun:test';
import { openStore } from '../hub/store.mjs';
import { DEDUPE_WINDOW_MS, dedupeKeyOf, isDuplicate, markSeen } from './notify.mjs';

const T0 = Date.parse('2026-11-25T02:00:00.000Z');

describe('dedupeKeyOf', () => {
  test('同 consumer + 标题 → 同键（跨进程稳定，可落库）', () => {
    expect(dedupeKeyOf('dws-auth-health', '登录态不可用')).toBe(dedupeKeyOf('dws-auth-health', '登录态不可用'));
  });

  test('consumer 或标题不同 → 不同键', () => {
    expect(dedupeKeyOf('a', 't')).not.toBe(dedupeKeyOf('b', 't'));
    expect(dedupeKeyOf('a', 't')).not.toBe(dedupeKeyOf('a', 't2'));
  });

  test('正文不影响键（正文常带时间戳，含进去等于关掉去重）', () => {
    // 函数签名只有 consumer + title，此处即契约声明
    expect(dedupeKeyOf.length).toBe(2);
  });
});

describe('isDuplicate / 窗口', () => {
  test('从未发过 → 不重复', () => {
    const s = openStore(':memory:');
    expect(isDuplicate(s, 'todo', dedupeKeyOf('c', 't'), T0)).toBe(false);
  });

  test('窗口内 → 重复；窗口外 → 可再发（todo 6h）', () => {
    const s = openStore(':memory:');
    const k = dedupeKeyOf('c', 't');
    markSeen(s, 'todo', k, T0);
    expect(isDuplicate(s, 'todo', k, T0 + 5 * 3600e3)).toBe(true);
    expect(isDuplicate(s, 'todo', k, T0 + 6 * 3600e3)).toBe(false);   // 边界：等于窗口即过期
  });

  test('窗口按通道区分（ding_call 30m 比 todo 6h 严）', () => {
    const s = openStore(':memory:');
    const k = dedupeKeyOf('c', 't');
    markSeen(s, 'ding_call', k, T0);
    markSeen(s, 'todo', k, T0);
    expect(DEDUPE_WINDOW_MS.ding_call).toBeLessThan(DEDUPE_WINDOW_MS.todo);
    expect(isDuplicate(s, 'ding_call', k, T0 + 31 * 60e3)).toBe(false);
    expect(isDuplicate(s, 'todo', k, T0 + 31 * 60e3)).toBe(true);
  });

  test('不同键互不影响', () => {
    const s = openStore(':memory:');
    markSeen(s, 'todo', dedupeKeyOf('c', 't1'), T0);
    expect(isDuplicate(s, 'todo', dedupeKeyOf('c', 't2'), T0)).toBe(false);
  });

  test('store 缺失/异常不抛（旁路）', () => {
    expect(isDuplicate(null, 'todo', 'k', T0)).toBe(false);
    expect(() => markSeen(null, 'todo', 'k', T0)).not.toThrow();
  });
});
