/**
 * scan 通道单测（设计 docs/design.md）
 * 覆盖：自适应间隔 / 静默时段 / 预算 / 水位 / 失败不推进 / 去重 / 覆盖审计 / 清理
 */
import { describe, expect, test } from 'bun:test';
import {
  advanceWatermark,
  coverage,
  DEFAULTS,
  getScanState,
  ingest,
  isQuietHour,
  maybePrune,
  nextIntervalMs,
  planWindow,
  prune,
  recordFailure,
  recordRun,
  shouldScan,
} from './scan.mjs';
import { openStore } from './store.mjs';
import { domainsOf, shouldDeliver } from './dispatch.mjs';

const evt = (id, scope, at, extra = {}) => ({ ext_id: id, scope, at, text: `t-${id}`, source: 'scan', outbound: false, ...extra });

function setup() {
  const s = openStore(':memory:');
  s.consumers.upsert({ name: 'A', targets: ['group:c1', 'direct:*'], batch_window: 0, on_event: 'true' });
  s.consumers.upsert({ name: 'B', targets: ['group:c2'], batch_window: 0, on_event: 'true' });
  return s;
}

describe('scan / 自适应间隔', () => {
  test('BC1 连续 0 条翻倍，封顶 30min；有消息回基准', () => {
    expect(nextIntervalMs({ streak: 0 })).toBe(5 * 60e3);
    expect(nextIntervalMs({ streak: 1 })).toBe(10 * 60e3);
    expect(nextIntervalMs({ streak: 2 })).toBe(20 * 60e3);
    expect(nextIntervalMs({ streak: 3 })).toBe(DEFAULTS.maxMs);
    expect(nextIntervalMs({ streak: 99 })).toBe(DEFAULTS.maxMs);
  });
});

describe('scan / 静默时段', () => {
  const at = (h) => new Date(2026, 10, 4, h, 0, 0);

  test('BC2 20:00–09:00 跨零点判断', () => {
    expect(isQuietHour(at(20))).toBe(true);
    expect(isQuietHour(at(23))).toBe(true);
    expect(isQuietHour(at(0))).toBe(true);
    expect(isQuietHour(at(8))).toBe(true);
    expect(isQuietHour(at(9))).toBe(false);
    expect(isQuietHour(at(14))).toBe(false);
  });
});

describe('scan / shouldScan 闸门', () => {
  test('BC3 首次 → due；间隔内 → 不扫；连续失败 → backoff；超日预算 → budget', () => {
    const s = setup();
    expect(shouldScan(s, { now: Date.parse('2026-11-04T10:00:00Z') }).due).toBe(true);

    advanceWatermark(s, '2026-11-04T10:00:00Z', { now: Date.parse('2026-11-04T10:00:00Z'), messages: 3 });
    expect(shouldScan(s, { now: Date.parse('2026-11-04T10:01:00Z') })).toMatchObject({ due: false, reason: 'interval' });

    for (let i = 0; i < 3; i += 1) recordFailure(s, { now: Date.parse('2026-11-04T10:05:00Z'), error: 'x' });
    expect(shouldScan(s, { now: Date.parse('2026-11-04T10:06:00Z') })).toMatchObject({ due: false, reason: 'backoff' });

    const s2 = setup();
    s2.kv.set('scan', 'calls_day', '2026-11-04');
    s2.kv.set('scan', 'calls_today', DEFAULTS.maxCallsPerDay);
    expect(shouldScan(s2, { now: Date.parse('2026-11-04T10:00:00Z') })).toMatchObject({ due: false, reason: 'budget' });
  });
});

describe('scan / 窗口与水位', () => {
  test('BC4 首跑回溯 lookback；有水位从水位起', () => {
    const s = setup();
    const now = Date.parse('2026-11-04T10:00:00Z');
    const w1 = planWindow(s, { now, lookbackH: 24 });
    expect(w1.first).toBe(true);
    expect(w1.from).toBe(new Date(now - 24 * 3600e3).toISOString());

    advanceWatermark(s, '2026-11-04T09:00:00Z', { now, messages: 0 });
    const w2 = planWindow(s, { now, lookbackH: 24 });
    expect(w2.first).toBe(false);
    expect(w2.from).toBe('2026-11-04T09:00:00Z');
  });

  test('BC5 有消息清零 streak；无消息累加；调用数按天累计', () => {
    const s = setup();
    const now = Date.parse('2026-11-04T10:00:00Z');
    advanceWatermark(s, 'a', { now, messages: 0 });
    expect(getScanState(s).zero_streak).toBe(1);
    expect(getScanState(s).interval_ms).toBe(10 * 60e3);
    advanceWatermark(s, 'b', { now, messages: 5 });
    expect(getScanState(s).zero_streak).toBe(0);
    expect(getScanState(s).calls_today).toBe(2);
  });

  test('BC6 失败**不推进水位**，只累计 fails', () => {
    const s = setup();
    advanceWatermark(s, 'w1', { now: 1, messages: 1 });
    recordFailure(s, { now: 2, error: 'network' });
    expect(getScanState(s).watermark).toBe('w1');
    expect(getScanState(s).fails).toBe(1);
    expect(getScanState(s).last_error).toBe('network');
    // 下一次完整成功 → 清空 last_error（health 不显示过期错误）
    advanceWatermark(s, 'w2', { now: 3, messages: 1 });
    expect(getScanState(s).last_error).toBeNull();
  });
});

describe('scan / 入库与审计', () => {
  test('BC7 重复 ext_id 只算一次', () => {
    const s = setup();
    expect(ingest(s, [evt('m1', 'group:c1', '2026-11-04T10:00:00Z')])).toBe(1);
    expect(ingest(s, [evt('m1', 'group:c1', '2026-11-04T10:00:00Z')])).toBe(0);
  });

  test('BC8 recordRun 落审计行', () => {
    const s = setup();
    recordRun(s, { startedAt: 'a', finishedAt: 'b', from: 'x', to: 'y', messages: 3, pages: 1, ok: true });
    const row = s.db.query('SELECT * FROM hub_scan_runs').get();
    expect(row.messages).toBe(3);
    expect(row.ok).toBe(1);
  });

  test('BC9 coverage：每任务 + 并集 + 未覆盖', () => {
    const s = setup();
    ingest(s, [
      evt('m1', 'group:c1', '2026-11-04T10:00:00Z'),
      evt('m2', 'group:c2', '2026-11-04T10:01:00Z'),
      evt('m3', 'direct:u1', '2026-11-04T10:02:00Z'),
      evt('m4', 'group:c9', '2026-11-04T10:03:00Z'),
    ]);
    const c = coverage(s, { consumers: s.consumers.all(), sinceIso: '2026-11-04T00:00:00Z' });
    expect(c.total_scopes).toBe(4);
    expect(c.tasks.find((t) => t.name === 'A')).toMatchObject({ scopes: 2, messages: 2 }); // c1 + direct:u1
    expect(c.tasks.find((t) => t.name === 'B')).toMatchObject({ scopes: 1, messages: 1 }); // c2
    expect(c.union_scopes).toBe(3);
    expect(c.uncovered_scopes).toBe(1); // c9
    expect(c.uncovered).toEqual(['group:c9']);
  });

  test('BC20 maybePrune 每日一次（24h 内跳过）', () => {
    const s = setup();
    ingest(s, [evt('old', 'group:c1', '2026-01-01T00:00:00Z')]);
    const now = Date.parse('2026-11-05T00:00:00Z');
    const r1 = maybePrune(s, { now, retainDays: 90 });
    expect(r1.skipped).toBe(false);
    expect(r1.deleted).toBe(1);
    const r2 = maybePrune(s, { now: now + 3600e3, retainDays: 90 });
    expect(r2.skipped).toBe(true);
    expect(r2.nextInMs).toBeGreaterThan(0);
  });

  test('BC21 getScanState 暴露 prune 审计字段（health 可见）', () => {
    const s = setup();
    const now = Date.parse('2026-11-05T00:00:00Z');
    maybePrune(s, { now, retainDays: 90 });
    const st = getScanState(s);
    expect(st.last_prune_at).toBe(now);
    expect(st.last_prune_deleted).toBeGreaterThanOrEqual(0);
  });

  test('BC10 prune 删除过期事件', () => {
    const s = setup();
    ingest(s, [evt('old', 'group:c1', '2026-01-01T00:00:00Z'), evt('new', 'group:c1', '2026-11-04T00:00:00Z')]);
    const r = prune(s, { now: Date.parse('2026-11-04T12:00:00Z'), retainDays: 90 });
    expect(r.deleted).toBe(1);
    expect(s.db.query('SELECT COUNT(*) AS n FROM hub_events').get().n).toBe(1);
  });
});

describe('scan / 任务关注范围（domains）', () => {
  const s = setup();
  const A = s.consumers.byName('A');

  test('BC11 scopes 命中 + 关键词 AND', () => {
    const c = { ...A, domains: { scopes: ['group:c1'], keywords: ['工单'] } };
    expect(shouldDeliver(c, evt('1', 'group:c1', 'x', { text: '工单 123' }))).toBe(true);
    expect(shouldDeliver(c, evt('2', 'group:c1', 'x', { text: '闲聊' }))).toBe(false);
    expect(shouldDeliver(c, evt('3', 'group:c2', 'x', { text: '工单 123' }))).toBe(false);
  });

  test('BC12 mentionMe / senders', () => {
    const m = { ...A, domains: { scopes: ['group:c1'], mentionMe: true } };
    expect(shouldDeliver(m, evt('1', 'group:c1', 'x', { meta: { mentionMe: true } }))).toBe(true);
    expect(shouldDeliver(m, evt('2', 'group:c1', 'x', { meta: {} }))).toBe(false);

    const sn = { ...A, domains: { scopes: ['direct:*'], senders: ['carol'] } };
    expect(shouldDeliver(sn, evt('3', 'direct:u1', 'x', { sender: 'carol' }))).toBe(true);
    expect(shouldDeliver(sn, evt('4', 'direct:u1', 'x', { sender: '别人' }))).toBe(false);
  });

  test('BC13 无 domains 时向后兼容（targets + keywords）', () => {
    expect(domainsOf(A)).toMatchObject({ scopes: ['group:c1', 'direct:*'], keywords: null });
    expect(shouldDeliver(A, evt('1', 'group:c1', 'x'))).toBe(true);
    expect(shouldDeliver(A, evt('2', 'group:c9', 'x'))).toBe(false);
    expect(shouldDeliver({ ...A, keywords: ['报错'] }, evt('3', 'group:c1', 'x', { text: '报错' }))).toBe(true);
  });

  test('BC14 outbound 永不派发', () => {
    expect(shouldDeliver(A, evt('1', 'group:c1', 'x', { outbound: true }))).toBe(false);
  });
});
