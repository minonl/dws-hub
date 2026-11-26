/**
 * dws-hub · hub 层（渠道无关）—— 降级 / 恢复阶梯
 *
 * 设计：docs/design.md（**关键补充**，用户 2026-10-16 追问）
 *
 * 用户原话：「退避降级到底以后，还会往上恢复吗？因为最好还是能恢复长链接实时推送」
 * ⇒ **原则：降级是临时态，不是终点；恢复必须自动。**
 *
 * ══ 两层层级 ══
 * ① 连接级退避（单次断线，1s→60s 封顶）—— 由适配器负责，成功即重置，**不在这里**；
 * ② 模式级降级（连续失败达上限）—— 本模块负责：进 degraded（纯轮询）+ 恢复探针（每 5min），
 *    连续 2 次**强判据**达标 → 自动回升 healthy。
 *
 * ══ 判据强度（**不能只看「连上了」**）══
 * 实测过「connected 却 0 事件」；故：
 *   strong   = 探测窗口内**真收到事件**
 *   weak     = 连上但窗口内无信号（群本来没消息 / 不确定）→ **不足以升级**，但也不算失败
 *   mismatch = 窗口内**权威口径有消息、本通道 0 事件** → **落差**（通道不可靠的证据）
 *   fail     = 连不上
 *
 * ══ 通道能力记忆 ══
 * 连续 mismatch ≥3 → 标记 `unsupported`：该 kind **不再进退避/恢复循环**（避免无意义重连），
 * 一律由权威通道（轮询）承担。恢复机制只对「曾证明可用」的通道生效。
 */
export const STATES = ['healthy', 'backing_off', 'degraded', 'unsupported'];

const DEFAULTS = {
  upgradeStreak: 2,        // 连续 2 次强判据 → 回升
  downgradeStreak: 5,      // 连续 5 次失败 → 降级
  probeIntervalMs: 5 * 60e3,
  mismatchToUnsupported: 3,
};

function ns(kind) { return `ladder:${kind}`; }

export function getState(store, kind) {
  return store.kv.get(ns(kind), 'state', 'healthy');
}

export function history(store, kind) {
  return store.kv.get(ns(kind), 'history', []);
}

function pushHistory(store, kind, entry) {
  const h = history(store, kind);
  store.kv.set(ns(kind), 'history', [...h, entry].slice(-200));
  return entry;
}

/** 判据分级：把「探测结果」归一成 strong / weak / mismatch / fail。 */
export function probeResult({ received = 0, authoritative = 0, connected = false } = {}) {
  if (received > 0) return 'strong';
  if (!connected) return 'fail';
  if (authoritative > 0) return 'mismatch';
  if (authoritative === 0) return 'weak';
  return 'weak';
}

/**
 * 用一次探测结果推进阶梯（纯状态推进，落库 + 留痕）。
 * @returns {{kind:string, state:string, changed:boolean, reason:string, counters:object}}
 */
export function evaluate(store, kind, probe, { now = Date.now(), ...opt } = {}) {
  const cfg = { ...DEFAULTS, ...opt };
  const from = getState(store, kind);
  if (from === 'unsupported') {
    return { kind, state: 'unsupported', changed: false, reason: 'unsupported_memory', counters: counters(store, kind) };
  }
  const result = typeof probe === 'string' ? probe : probeResult(probe);
  const c = counters(store, kind);
  if (result === 'strong') { c.strongStreak += 1; c.failStreak = 0; c.mismatch += 0; }
  else if (result === 'mismatch') { c.mismatch += 1; c.strongStreak = 0; c.failStreak += 1; }
  else if (result === 'fail') { c.failStreak += 1; c.strongStreak = 0; }
  else { /* weak：无信号，不升级也不惩罚（单聊有效、群可能本来没消息） */ }

  let next = from;
  let reason = `probe_${result}`;

  if (from === 'degraded' || from === 'backing_off') {
    if (c.strongStreak >= cfg.upgradeStreak) { next = 'healthy'; reason = 'recovered_strong_streak'; }
  } else if (from === 'healthy') {
    if (c.failStreak >= cfg.downgradeStreak || c.mismatch >= cfg.mismatchToUnsupported) {
      next = 'degraded';
      reason = c.mismatch >= cfg.mismatchToUnsupported ? 'mismatch_streak' : 'fail_streak';
    }
  }

  // 结构性不可用：连续落差达阈值 → 永久交给权威通道
  if (c.mismatch >= cfg.mismatchToUnsupported && next === 'degraded') {
    next = 'unsupported';
    reason = 'mismatch_unsupported';
  }

  saveCounters(store, kind, c);
  store.kv.set(ns(kind), 'next_probe_at', now + cfg.probeIntervalMs);
  if (next !== from) {
    store.kv.set(ns(kind), 'state', next);
    pushHistory(store, kind, { at: new Date(now).toISOString(), from, to: next, reason, counters: { ...c } });
  }
  return { kind, state: next, changed: next !== from, reason, counters: { ...c } };
}

/** 连接级退避用完（适配器判定「连续失败达上限」）→ 显式降级，并安排首次恢复探测。 */
export function degrade(store, kind, { now = Date.now(), reason = 'backoff_exhausted', probeIntervalMs = DEFAULTS.probeIntervalMs } = {}) {
  const from = getState(store, kind);
  if (from === 'unsupported') return { kind, state: from, changed: false, reason: 'unsupported_memory' };
  store.kv.set(ns(kind), 'state', 'degraded');
  store.kv.set(ns(kind), 'next_probe_at', now + probeIntervalMs);
  pushHistory(store, kind, { at: new Date(now).toISOString(), from, to: 'degraded', reason });
  return { kind, state: 'degraded', changed: from !== 'degraded', reason };
}

/** 手动强制重试（`dws-hub health --reconnect`）：重置计数，回到探测态。 */
export function reset(store, kind, { now = Date.now(), reason = 'manual' } = {}) {
  saveCounters(store, kind, { strongStreak: 0, failStreak: 0, mismatch: 0 });
  store.kv.set(ns(kind), 'state', 'healthy');
  pushHistory(store, kind, { at: new Date(now).toISOString(), from: getState(store, kind), to: 'healthy', reason });
  return { kind, state: 'healthy', changed: true, reason };
}

export function markUnsupported(store, kind, { now = Date.now(), reason = 'manual' } = {}) {
  const from = getState(store, kind);
  store.kv.set(ns(kind), 'state', 'unsupported');
  pushHistory(store, kind, { at: new Date(now).toISOString(), from, to: 'unsupported', reason });
  return { kind, state: 'unsupported', changed: from !== 'unsupported', reason };
}

export function isSupported(store, kind) {
  return getState(store, kind) !== 'unsupported';
}

export function nextProbeAt(store, kind) {
  return store.kv.get(ns(kind), 'next_probe_at', 0) || 0;
}

/** 是否到恢复探测时间（degraded 态下每 probeIntervalMs 探一次）。 */
export function shouldProbe(store, kind, now = Date.now()) {
  return getState(store, kind) === 'degraded' && now >= nextProbeAt(store, kind);
}

function counters(store, kind) {
  return store.kv.get(ns(kind), 'counters', { strongStreak: 0, failStreak: 0, mismatch: 0 });
}

function saveCounters(store, kind, c) {
  store.kv.set(ns(kind), 'counters', c);
}

/** health 汇总：各 kind 的档位 + 近 24h 变迁史。 */
export function rollup(store, kinds, { now = Date.now(), windowMs = 24 * 3600e3 } = {}) {
  const out = {};
  for (const kind of kinds) {
    const h = history(store, kind).filter((e) => now - Date.parse(e.at) <= windowMs);
    out[kind] = {
      state: getState(store, kind),
      counters: counters(store, kind),
      next_probe_at: nextProbeAt(store, kind) ? new Date(nextProbeAt(store, kind)).toISOString() : null,
      changes_24h: h.length,
      last_change: h.length ? h[h.length - 1] : null,
    };
  }
  return out;
}
