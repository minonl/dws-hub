/** hub 层单测：订阅匹配 / 触发合并 / 独立游标 / 失败退避（docs/design.md、边界 B6–B10） */
import { describe, expect, test } from 'bun:test';
import { openStore } from './store.mjs';
import { backoffState, dispatchOnce, getCursor, inflightConsumers, matchScope, pendingFor, recordFailure, selectBatch, setCursor, shouldDeliver } from './dispatch.mjs';

const evt = (id, scope, at, extra = {}) => ({ ext_id: id, scope, at, text: `t-${id}`, source: 'poll', outbound: false, ...extra });

describe('dispatch / matchScope', () => {
  test('作用域匹配：精确、通配、不误命中', () => {
    expect(matchScope('self', 'self')).toBe(true);
    expect(matchScope('group:c1', 'group:c1')).toBe(true);
    expect(matchScope('group:c1', 'group:c2')).toBe(false);
    expect(matchScope('group:*', 'group:c2')).toBe(true);
    expect(matchScope('*', 'anything')).toBe(true);
    expect(matchScope('group:*', 'self')).toBe(false);
  });
});

describe('dispatch / shouldDeliver', () => {
  const consumer = { name: 'ledger', targets: ['self', 'group:c1'], keywords: null };

  test('匹配作用域即收；自己发出的不收（防回环）', () => {
    expect(shouldDeliver(consumer, evt('m1', 'self', 'x'))).toBe(true);
    expect(shouldDeliver(consumer, evt('m2', 'group:c9', 'x'))).toBe(false);
    expect(shouldDeliver(consumer, evt('m3', 'self', 'x', { outbound: true }))).toBe(false);
  });

  test('有关键词时只收命中的', () => {
    const kw = { ...consumer, keywords: ['无法', '报错'] };
    expect(shouldDeliver(kw, evt('m4', 'self', 'x', { text: '无法保存' }))).toBe(true);
    expect(shouldDeliver(kw, evt('m5', 'self', 'x', { text: '今天天气不错' }))).toBe(false);
  });
});

describe('dispatch / 触发合并（batch window）', () => {
  test('窗口未到不派发；窗口到了才合并', () => {
    const now = Date.parse('2026-10-16T12:00:30.000Z');
    const events = [
      evt('a', 'self', '2026-10-16T12:00:00.000Z'),   // 30s 前
      evt('b', 'self', '2026-10-16T12:00:25.000Z'),   // 5s 前
    ];
    expect(selectBatch(events, 60_000, now).map((e) => e.ext_id)).toEqual([]);          // 都没成熟 → 等
    expect(selectBatch(events, 30_000, now).map((e) => e.ext_id)).toEqual(['a']);       // 30s 窗口 → 只 a 成熟
    expect(selectBatch(events, 5_000, now).map((e) => e.ext_id)).toEqual(['a', 'b']);   // 都成熟 → 合并一次派发
    expect(selectBatch(events, 0, now).length).toBe(2);                                 // 0 = 不合并
  });
});

describe('dispatch / dispatchOnce', () => {
  function setup() {
    const s = openStore(':memory:');
    s.consumers.upsert({ name: 'A', targets: ['self'], batch_window: 0, on_event: 'true' });
    s.consumers.upsert({ name: 'B', targets: ['*'], batch_window: 0, on_event: 'true' });
    s.events.insert(evt('m1', 'self', '2026-10-16T12:00:00.000Z'));
    s.events.insert(evt('m2', 'group:c1', '2026-10-16T12:00:01.000Z'));
    return s;
  }

  test('多消费者各自独立消费同一事件流（不重不漏）', async () => {
    const s = setup();
    const calls = [];
    const run = async (consumer, batch) => { calls.push([consumer.name, batch.map((e) => e.ext_id)]); return { ok: true, code: 0 }; };
    const now = Date.parse('2026-10-16T12:01:00.000Z');
    await dispatchOnce({ store: s, now, run });
    expect(calls).toEqual([['A', ['m1']], ['B', ['m1', 'm2']]]);
    expect(getCursor(s, 'A')).toBe('2026-10-16T12:00:00.000Z');
    expect(getCursor(s, 'B')).toBe('2026-10-16T12:00:01.000Z');
    // 再跑一轮：游标之后无事件 → 不再派发
    calls.length = 0;
    await dispatchOnce({ store: s, now: now + 60_000, run });
    expect(calls.length).toBe(0);
  });

  test('回调失败：不动游标 + 退避，下轮可重试（不丢）', async () => {
    const s = setup();
    const run = async () => ({ ok: false, code: 1, reason: 'nonzero_exit' });
    const now = Date.parse('2026-10-16T12:01:00.000Z');
    const summary = await dispatchOnce({ store: s, now, run });
    expect(summary.A.failed).toBe(1);
    expect(getCursor(s, 'A')).toBe('1970-01-01T00:00:00.000Z');       // 未推进
    expect(backoffState(s, 'A', now).nextAttemptAt).toBeGreaterThan(now);
    // 退避窗口内跳过
    const skipped = await dispatchOnce({ store: s, now: now + 1000, run });
    expect(skipped.A.skipped).toBe('backoff');
    // 退避过后重试成功 → 推进游标
    const later = backoffState(s, 'A', now).nextAttemptAt + 1;
    const ok = await dispatchOnce({ store: s, now: later, run: async () => ({ ok: true, code: 0 }) });
    expect(ok.A.delivered).toBe(1);
    expect(getCursor(s, 'A')).toBe('2026-10-16T12:00:00.000Z');
  });

  test('一个消费者失败不影响另一个（边界 B10）', async () => {
    const s = setup();
    const run = async (consumer) => (consumer.name === 'A' ? { ok: false, code: 1 } : { ok: true, code: 0 });
    const now = Date.parse('2026-10-16T12:01:00.000Z');
    const summary = await dispatchOnce({ store: s, now, run });
    expect(summary.A.failed).toBe(1);
    expect(summary.B.delivered).toBe(2);
  });

  test('async 模式：**慢消费者不阻塞 tick**，完成后才落游标；在跑期间不重复投递', async () => {
    const s = openStore(':memory:');
    s.consumers.upsert({ name: 'A', targets: ['self'], batch_window: 0, on_event: 'true' });
    s.events.insert(evt('m1', 'self', '2026-10-16T12:00:00.000Z'));
    let resolveRun;
    const slowRun = () => new Promise((res) => { resolveRun = () => res({ ok: true, code: 0 }); });
    const now = Date.parse('2026-10-16T12:01:00.000Z');
    const r1 = await dispatchOnce({ store: s, now, run: slowRun, mode: 'async' });
    expect(r1.A.started).toBe(1);                                  // 立刻返回（不等消费者）
    expect(getCursor(s, 'A')).toBe('1970-01-01T00:00:00.000Z');    // 尚未落游标
    expect(inflightConsumers()).toContain('A');
    // 在跑期间再派发 → 跳过（防重投）
    const r2 = await dispatchOnce({ store: s, now: now + 1000, run: async () => ({ ok: true, code: 0 }), mode: 'async' });
    expect(r2.A.skipped).toBe('in_flight');
    // 消费者完成后 → 游标落盘
    resolveRun();
    await new Promise((res) => setTimeout(res, 10));
    expect(getCursor(s, 'A')).toBe('2026-10-16T12:00:00.000Z');
    expect(inflightConsumers()).not.toContain('A');
  });

  test('BC：成功消费写 last_delivered_at；失败不写（区分「进程活着」与「真的在消费」）', async () => {
    const s = setup();
    const now = Date.parse('2026-10-16T12:01:00.000Z');
    await dispatchOnce({ store: s, now, run: async () => ({ ok: false, code: 1 }) });
    expect(s.kv.get('dispatch:A', 'last_delivered_at', null)).toBe(null);
    // 失败进入退避；等退避过后再成功消费
    const later = now + 10 * 60e3;
    await dispatchOnce({ store: s, now: later, run: async () => ({ ok: true, code: 0 }) });
    expect(s.kv.get('dispatch:A', 'last_delivered_at', null)).toBe(new Date(later).toISOString());
  });

  test('pendingFor 以消费者游标为准（崩溃后可补派）', () => {
    const s = setup();
    const A = s.consumers.byName('A');
    expect(pendingFor(s, A).map((e) => e.ext_id)).toEqual(['m1']);
    setCursor(s, 'A', '2026-10-16T12:00:00.500Z');
    expect(pendingFor(s, A).length).toBe(0);
    const f = recordFailure(s, 'A', Date.now());
    expect(f.fails).toBe(1);
    expect(f.retryInMs).toBeGreaterThan(0);
  });
});
