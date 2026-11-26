/**
 * scan 通道（**渠道无关**）—— 全量增量扫描的调度、入库与覆盖审计
 *
 * 设计：docs/design.md
 * ⚠️ 分层纪律：本文件不得出现渠道字样；拉取（跨会话增量拉取）在渠道适配层，
 *    这里只回答三件事：**何时扫 / 扫到的东西怎么记 / 任务覆盖怎么算**。
 *
 * 任务模型（用户 2026-11-04 澄清）：总范围 = 任务 A ∪ B ∪ … ∪ N；
 * scan 是共享数据底座，任务各自声明关注范围（domains）并独立消费。
 */
import { shouldDeliver } from './dispatch.mjs';

/** KV 命名空间：`scan` / `watermark` */
export const SCAN_NS = 'scan';

export const DEFAULTS = {
  baseMs: 5 * 60e3,        // 活跃时 5 分钟
  maxMs: 30 * 60e3,        // 静默退避上限 30 分钟
  lookbackH: 24,           // 首跑回溯
  quietStart: 20,          // 20:00
  quietEnd: 9,             // 09:00
  retainDays: 90,
  maxCallsPerDay: 400,
};

export function getScanState(store) {
  return {
    watermark: store.kv.get(SCAN_NS, 'watermark', null),
    interval_ms: Number(store.kv.get(SCAN_NS, 'interval_ms', DEFAULTS.baseMs)) || DEFAULTS.baseMs,
    zero_streak: Number(store.kv.get(SCAN_NS, 'zero_streak', 0)) || 0,
    last_run_at: store.kv.get(SCAN_NS, 'last_run_at', null),
    last_ok_at: store.kv.get(SCAN_NS, 'last_ok_at', null),
    fails: Number(store.kv.get(SCAN_NS, 'fails', 0)) || 0,
    calls_today: Number(store.kv.get(SCAN_NS, 'calls_today', 0)) || 0,
    calls_day: store.kv.get(SCAN_NS, 'calls_day', null),
    // 每日清理审计（health 展示）
    last_prune_at: store.kv.get(SCAN_NS, 'last_prune_at', null),
    last_prune_deleted: store.kv.get(SCAN_NS, 'last_prune_deleted', null),
    last_error: store.kv.get(SCAN_NS, 'last_error', null),
  };
}

export function setScanState(store, patch) {
  for (const [k, v] of Object.entries(patch)) store.kv.set(SCAN_NS, k, v);
}

/** 静默时段（跨零点）：[start, 24) ∪ [0, end)。 */
export function isQuietHour(date, start = DEFAULTS.quietStart, end = DEFAULTS.quietEnd) {
  const h = date.getHours();
  return start > end ? h >= start || h < end : h >= start && h < end;
}

/** 自适应间隔：连续 0 条 → 翻倍；有消息 → 回到基准。 */
export function nextIntervalMs({ streak = 0, baseMs = DEFAULTS.baseMs, maxMs = DEFAULTS.maxMs } = {}) {
  const factor = 2 ** Math.min(Math.max(streak, 0), 4);
  return Math.min(maxMs, baseMs * factor);
}

/** 是否到点扫描（含静默时段、退避、日预算）。 */
export function shouldScan(store, {
  now = Date.now(),
  baseMs = DEFAULTS.baseMs,
  maxMs = DEFAULTS.maxMs,
  quietStart = DEFAULTS.quietStart,
  quietEnd = DEFAULTS.quietEnd,
  maxCallsPerDay = DEFAULTS.maxCallsPerDay,
} = {}) {
  const st = getScanState(store);
  const nowDate = new Date(now);
  const quiet = isQuietHour(nowDate, quietStart, quietEnd);
  const interval = quiet ? maxMs : st.interval_ms;
  const last = st.last_run_at ? Date.parse(st.last_run_at) : 0;
  // ⚠️ 先判 backoff：连续失败时，退避优先于常规间隔（否则 interval 永远抢先）
  if (st.fails >= 3 && last && now - last < maxMs) return { due: false, reason: 'backoff', intervalMs: maxMs };
  if (last && now - last < interval) return { due: false, reason: 'interval', intervalMs: interval };
  const day = nowDate.toISOString().slice(0, 10);
  const callsToday = st.calls_day === day ? st.calls_today : 0;
  if (callsToday >= maxCallsPerDay) return { due: false, reason: 'budget', intervalMs: maxMs };
  return { due: true, intervalMs: interval, quiet, callsToday };
}

/** 计算本次扫描窗口：`[watermark, now)`；首跑用 lookback 截断。 */
export function planWindow(store, { now = Date.now(), lookbackH = DEFAULTS.lookbackH } = {}) {
  const st = getScanState(store);
  const to = new Date(now).toISOString();
  const first = !st.watermark;
  const from = st.watermark || new Date(now - lookbackH * 3600e3).toISOString();
  return { from, to, first };
}

/** 记录一次运行（审计 / 成本观察）。 */
export function recordRun(store, { startedAt, finishedAt, from, to, messages = 0, pages = 0, ok = false, error = null }) {
  store.db.query(
    `INSERT INTO hub_scan_runs (started_at, finished_at, window_from, window_to, messages, pages, ok, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(startedAt, finishedAt ?? null, from, to, messages, pages, ok ? 1 : 0, error);
}

/** 推进水位（**只在完整成功后调用**；失败保持原水位）。 */
export function advanceWatermark(store, iso, { now = Date.now(), messages = 0 } = {}) {
  const st = getScanState(store);
  const streak = messages > 0 ? 0 : st.zero_streak + 1;
  const day = new Date(now).toISOString().slice(0, 10);
  const callsToday = (st.calls_day === day ? st.calls_today : 0) + 1;
  setScanState(store, {
    watermark: iso,
    last_ok_at: new Date(now).toISOString(),
    last_run_at: new Date(now).toISOString(),
    interval_ms: nextIntervalMs({ streak }),
    zero_streak: streak,
    fails: 0,
    // 成功即清除上一次错误（否则 health 会长期显示过期错误）
    last_error: null,
    calls_today: callsToday,
    calls_day: day,
  });
}

/** 失败：不推进水位，累计 fails + 退避。 */
export function recordFailure(store, { now = Date.now(), error = '' } = {}) {
  const st = getScanState(store);
  setScanState(store, {
    last_run_at: new Date(now).toISOString(),
    fails: st.fails + 1,
    interval_ms: nextIntervalMs({ streak: st.zero_streak + 1 }),
    last_error: (typeof error === 'string' ? error : JSON.stringify(error || '')).slice(0, 300),
  });
}

/** 入库一批**已归一**的事件（ext_id/scope/at/...）；返回新插入数量。 */
export function ingest(store, events = []) {
  let inserted = 0;
  for (const e of events) if (store.events.insert(e)) inserted += 1;
  return inserted;
}

/** 覆盖审计：每个任务的会话/消息数 + 并集 + 未覆盖。 */
export function coverage(store, { consumers = [], sinceIso } = {}) {
  const rows = store.db.query('SELECT ext_id, scope, text, sender, at, source, outbound FROM hub_events WHERE at >= ?').all(sinceIso);
  const allScopes = new Set(rows.map((r) => r.scope));
  const perTask = consumers.map((c) => {
    const hit = rows.filter((r) => shouldDeliver(c, { ...r, outbound: Boolean(r.outbound), meta: null }));
    return {
      name: c.name,
      kind: c.kind || 'task',
      scopes: new Set(hit.map((r) => r.scope)).size,
      messages: hit.length,
    };
  });
  const union = new Set();
  for (const r of rows) if (consumers.some((c) => shouldDeliver(c, { ...r, outbound: Boolean(r.outbound), meta: null }))) union.add(r.scope);
  const uncovered = [...allScopes].filter((s) => !union.has(s));
  return {
    total_scopes: allScopes.size,
    total_messages: rows.length,
    tasks: perTask,
    union_scopes: union.size,
    uncovered_scopes: uncovered.length,
    uncovered: uncovered.slice(0, 50),
  };
}

/** 每日一次的清理（由 scanOnce 调用）：24h 内只跑一次，结果写 kv 供 health 看。 */
export function maybePrune(store, { now = Date.now(), retainDays = DEFAULTS.retainDays, everyMs = 86400e3 } = {}) {
  const last = Number(store.kv.get(SCAN_NS, 'last_prune_at', 0)) || 0;
  if (last && now - last < everyMs) return { skipped: true, nextInMs: everyMs - (now - last) };
  const r = prune(store, { now, retainDays });
  store.kv.set(SCAN_NS, 'last_prune_at', now);
  store.kv.set(SCAN_NS, 'last_prune_deleted', r.deleted);
  return { skipped: false, ...r };
}

/** 清理过期事件（保留期滚动）。 */
export function prune(store, { now = Date.now(), retainDays = DEFAULTS.retainDays, batch = 1000 } = {}) {
  const cutoff = new Date(now - retainDays * 86400e3).toISOString();
  const r = store.db.query('DELETE FROM hub_events WHERE at < ?').run(cutoff);
  return { deleted: r.changes ?? 0, cutoff, batch };
}
