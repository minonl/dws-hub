/** hub 层单测：锚点识别 / 状态机 / 超时（docs/design.md、docs/design.md、边界 B3/B4/B5） */
import { describe, expect, test } from 'bun:test';
import { openStore } from './store.mjs';
import { ANCHOR_RE, createAnchor, dueAnchors, localDay, markExpired, markReminded, matchReply, newAnchorId, recordOutbound, recordReply, renderAnchorText } from './anchors.mjs';

const T = (s) => Date.parse(s);

describe('anchors', () => {
  test('事项号格式与本地日期', () => {
    expect(ANCHOR_RE.exec('见 anchor-2026-10-16-007 处理')?.[1]).toBe('anchor-2026-10-16-007');
    // +08:00 的本地日：UTC 18:00 已是次日
    expect(localDay(T('2026-10-16T18:00:00.000Z'))).toBe('2026-10-17');
  });

  test('建锚点：id 递增 + 初始 open', () => {
    const s = openStore(':memory:');
    const a1 = createAnchor(s, { consumer: 'ledger', strength: 'strong', title: 't1', scope: 'self', ext_id: 'm1' });
    const a2 = createAnchor(s, { consumer: 'ledger', title: 't2', scope: 'self', ext_id: 'm2' });
    expect(a1.id).toMatch(/^anchor-\d{4}-\d{2}-\d{2}-001$/);
    expect(a2.id).toMatch(/-002$/);
    expect(a1.status).toBe('open');
    expect(newAnchorId(s)).toMatch(/-003$/);
  });

  test('识别回复：① 引用命中（主力）② 事项号兜底 ③ 识别不出不猜', () => {
    const s = openStore(':memory:');
    const a = createAnchor(s, { consumer: 'ledger', title: 't', scope: 'self', ext_id: 'anchor-msg' });
    // ① 引用
    const viaQuote = matchReply(s, { ext_id: 'r1', scope: 'self', text: '先别开', reply_to: 'anchor-msg' });
    expect(viaQuote.via).toBe('quote');
    expect(viaQuote.anchor.id).toBe(a.id);
    // ② 事项号
    const viaId = matchReply(s, { ext_id: 'r2', scope: 'self', text: `这个 ${a.id} 我问问产品` });
    expect(viaId.via).toBe('id');
    // ③ 都没有 → null（不猜）
    expect(matchReply(s, { ext_id: 'r3', scope: 'self', text: '随便说一句' })).toBeNull();
    // ④ 自己发出的消息永不算回复（防回环，docs/design.md）
    expect(matchReply(s, { ext_id: 'r4', scope: 'self', text: a.id, reply_to: 'anchor-msg', outbound: true })).toBeNull();
  });

  test('记录回复：open→answered；acting 保持；expired→acting（迟到仍认）', () => {
    const s = openStore(':memory:');
    const a = createAnchor(s, { consumer: 'x', title: 't', scope: 'self', ext_id: 'm' });
    let cur = recordReply(s, a, { ext_id: 'r', text: 'ok', at: '2026-10-16T01:00:00.000Z' });
    expect(cur.status).toBe('answered');
    cur = s.anchors.update(a.id, { status: 'acting' });
    cur = recordReply(s, cur, { ext_id: 'r2', text: 'ok2', at: '2026-10-16T02:00:00.000Z' });
    expect(cur.status).toBe('acting');
    cur = markExpired(s, a.id);
    expect(cur.status).toBe('expired');
    cur = recordReply(s, cur, { ext_id: 'r3', text: 'late', at: '2026-10-16T03:00:00.000Z' });
    expect(cur.status).toBe('acting');
    expect(cur.replies.filter((x) => x.direction === 'in').length).toBe(3);
  });

  test('出站记录：同一锚点链下留往来痕迹', () => {
    const s = openStore(':memory:');
    const a = createAnchor(s, { consumer: 'x', title: 't', scope: 'self', ext_id: 'm' });
    const cur = recordOutbound(s, a.id, { ext_id: 'o1', text: '已跳过', at: '2026-10-16T04:00:00.000Z' });
    expect(cur.replies).toEqual([{ extId: 'o1', direction: 'out', text: '已跳过', at: '2026-10-16T04:00:00.000Z' }]);
  });

  test('超时：24h 提醒一次、72h 归档（边界 B5）', () => {
    const s = openStore(':memory:');
    const now = T('2026-10-16T12:00:00.000Z');
    const mk = (id, created) => s.anchors.insert({
      id, created_at: created, updated_at: created, consumer: 'x', strength: 'info', needs_decision: true,
      title: 't', status: 'open', scope: 'self', ext_id: `e-${id}`, replies: [],
    });
    mk('anchor-2026-10-15-001', '2026-10-15T10:00:00.000Z');  // 26h 前 → 提醒
    mk('anchor-2026-10-13-001', '2026-10-13T08:00:00.000Z');  // 76h 前 → 归档
    mk('anchor-2026-10-16-001', '2026-10-16T11:00:00.000Z');  // 1h 前 → 无事
    const { toRemind, toExpire } = dueAnchors(s, { now });
    expect(toRemind.map((a) => a.id)).toEqual(['anchor-2026-10-15-001']);
    expect(toExpire.map((a) => a.id)).toEqual(['anchor-2026-10-13-001']);
    // 提醒过就不再提醒（只提醒一次）
    markReminded(s, 'anchor-2026-10-15-001');
    expect(dueAnchors(s, { now }).toRemind.length).toBe(0);
  });

  test('通知正文含事项号与引导语（便于人工引用）', () => {
    const s = openStore(':memory:');
    const a = createAnchor(s, { consumer: 'x', title: 't', scope: 'self', ext_id: 'm' });
    const text = renderAnchorText(a, '有 3 个 org 异常', { marker: '🤖 dws-hub · ledger' });
    expect(text).toContain('🤖 dws-hub · ledger');
    expect(text).toContain(a.id);
    expect(text).toContain('引用本条回复');
  });
});
