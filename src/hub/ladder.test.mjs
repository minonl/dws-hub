/** hub 层单测：限频闸（docs/design.md）与降级/恢复阶梯（docs/design.md） */
import { describe, expect, test } from 'bun:test';
import { openStore } from './store.mjs';
import { DEFAULT_RULES, allow, charge, inQuietHours, usage } from './ratelimit.mjs';
import { degrade, evaluate, getState, history, isSupported, markUnsupported, probeResult, reset, rollup, shouldProbe } from './ladder.mjs';

/** 2026-10-16 14:00 北京（= 06:00 UTC）—— 非静默时段 */
const T1400 = Date.parse('2026-10-16T06:00:00.000Z');
/** 2026-10-16 22:00 北京 —— 静默时段 */
const T2200 = Date.parse('2026-10-16T14:00:00.000Z');

describe('ratelimit', () => {
  test('静默时段判定（20:00–09:00）', () => {
    expect(inQuietHours(T1400, [20, 9])).toBe(false);
    expect(inQuietHours(T2200, [20, 9])).toBe(true);
    expect(inQuietHours(Date.parse('2026-10-16T00:30:00.000Z'), [20, 9])).toBe(true);   // 北京 08:30
    expect(inQuietHours(Date.parse('2026-10-16T01:00:00.000Z'), [20, 9])).toBe(false);  // 北京 09:00（边界外）
  });

  test('DING：静默时段拒绝、每日 2 条封顶', () => {
    expect(allow(openStore(':memory:'), 'strong_push', { now: T2200 }).reason).toBe('quiet_hours');
    const s = openStore(':memory:');
    expect(allow(s, 'strong_push', { now: T1400 }).ok).toBe(true);
    charge(s, 'strong_push', { now: T1400 });
    charge(s, 'strong_push', { now: T1400 });
    expect(allow(s, 'strong_push', { now: T1400 }).reason).toBe('per_day');
    // force 可越过静默（应急），但仍受额度约束
    expect(allow(s, 'strong_push', { now: T2200, force: true }).reason).toBe('per_day');
  });

  test('普通消息：每小时 6 条封顶；计数按小时/日分桶', () => {
    const s = openStore(':memory:');
    for (let i = 0; i < 6; i++) { expect(allow(s, 'message', { now: T1400 }).ok).toBe(true); charge(s, 'message', { now: T1400 }); }
    expect(allow(s, 'message', { now: T1400 }).reason).toBe('per_hour');
    // 下一小时恢复额度
    expect(allow(s, 'message', { now: T1400 + 3600e3 }).ok).toBe(true);
    const u = usage(s, { now: T1400 });
    expect(u.message.hour).toBe(6);
    expect(u.message.rule).toEqual(DEFAULT_RULES.message);
  });
});

describe('ladder（降级与恢复）', () => {
  test('判据分级：收到事件=强 / 权威有消息而本通道没有=落差 / 无信号=弱 / 连不上=失败', () => {
    expect(probeResult({ received: 2, authoritative: 5, connected: true })).toBe('strong');
    expect(probeResult({ received: 0, authoritative: 5, connected: true })).toBe('mismatch');
    expect(probeResult({ received: 0, authoritative: 0, connected: true })).toBe('weak');
    expect(probeResult({ received: 0, authoritative: 0, connected: false })).toBe('fail');
  });

  test('降级是临时态：**连续 2 次强判据自动回升**（用户追问的核心）', () => {
    const s = openStore(':memory:');
    const t = T1400;
    expect(degrade(s, 'stream:group', { now: t, reason: 'backoff_exhausted' }).state).toBe('degraded');
    expect(evaluate(s, 'stream:group', 'strong', { now: t + 1 }).changed).toBe(false);   // 1/2
    const up = evaluate(s, 'stream:group', 'strong', { now: t + 2 });
    expect(up.state).toBe('healthy');
    expect(up.reason).toBe('recovered_strong_streak');
    expect(history(s, 'stream:group').length).toBe(2);                                   // degrade + recover
  });

  test('弱判据不升级（不能靠「连上了」骗过恢复）', () => {
    const s = openStore(':memory:');
    degrade(s, 'stream:direct', { now: T1400 });
    for (let i = 0; i < 10; i++) evaluate(s, 'stream:direct', 'weak', { now: T1400 + i });
    expect(getState(s, 'stream:direct')).toBe('degraded');
  });

  test('连续 5 次失败才降级（防抖，避免边界横跳）', () => {
    const s = openStore(':memory:');
    for (let i = 0; i < 4; i++) evaluate(s, 'stream:direct', 'fail', { now: T1400 + i });
    expect(getState(s, 'stream:direct')).toBe('healthy');
    const d = evaluate(s, 'stream:direct', 'fail', { now: T1400 + 5 });
    expect(d.state).toBe('degraded');
    expect(d.reason).toBe('fail_streak');
  });

  test('连续 3 次落差 → 结构性不可用（不再空转重连）', () => {
    const s = openStore(':memory:');
    for (let i = 0; i < 3; i++) evaluate(s, 'stream:group', 'mismatch', { now: T1400 + i });
    expect(getState(s, 'stream:group')).toBe('unsupported');
    expect(isSupported(s, 'stream:group')).toBe(false);
    // unsupported 后不再变更（即使探测「成功」）
    expect(evaluate(s, 'stream:group', 'strong', { now: T1400 + 9 }).state).toBe('unsupported');
    expect(markUnsupported(s, 'stream:group').changed).toBe(false);
  });

  test('恢复探测节奏 + 手动重置 + rollup 变迁史', () => {
    const s = openStore(':memory:');
    degrade(s, 'stream:direct', { now: T1400, reason: 'backoff_exhausted' });
    expect(shouldProbe(s, 'stream:direct', T1400)).toBe(false);          // 刚降级，等 probeInterval
    expect(shouldProbe(s, 'stream:direct', T1400 + 5 * 60e3)).toBe(true);
    evaluate(s, 'stream:direct', 'weak', { now: T1400 + 5 * 60e3 });
    expect(reset(s, 'stream:direct', { now: T1400 + 6 * 60e3 }).state).toBe('healthy');
    const r = rollup(s, ['stream:direct', 'stream:group'], { now: T1400 + 7 * 60e3 });
    expect(r['stream:direct'].state).toBe('healthy');
    expect(r['stream:direct'].changes_24h).toBeGreaterThan(0);
  });
});
