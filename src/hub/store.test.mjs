/** hub 层单测：统一库（建表幂等 / KV / 事件去重 / 锚点 / 消费者）。docs/design.md */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.mjs';

// ⚠️ 临时文件**集中放一个目录 + 收尾清理**（2026-10-16 实测：此前散在 /tmp 从不清理，堆了几十个）
const TMP = join(tmpdir(), `dws-hub-store-test-${process.pid}`);
mkdirSync(TMP, { recursive: true });
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function tmpDb(name) {
  return join(TMP, `${name}.db`);
}

describe('store', () => {
  test('建表幂等：重复打开同一库无副作用', () => {
    const p = tmpDb('idem');
    const a = openStore(p);
    const tables1 = a.db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
    a.close();
    const b = openStore(p);
    const tables2 = b.db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
    expect(tables2).toEqual(tables1);
    expect(tables2).toContain('hub_consumers');
    expect(tables2).toContain('hub_anchors');
    expect(tables2).toContain('hub_events');
    expect(tables2).toContain('hub_ding_log');
    expect(tables2).toContain('kv_store');
    b.close();
  });

  test('kv：读写 + 自增计数', () => {
    const s = openStore(':memory:');
    expect(s.kv.get('ns', 'k', 'dflt')).toBe('dflt');
    s.kv.set('ns', 'k', { a: 1 });
    expect(s.kv.get('ns', 'k')).toEqual({ a: 1 });
    expect(s.kv.bump('ns', 'n')).toBe(1);
    expect(s.kv.bump('ns', 'n')).toBe(2);
  });

  test('事件：ext_id 去重 + 待派发 + 标记已派发', () => {
    const s = openStore(':memory:');
    const e = { ext_id: 'm1', scope: 'group:c1', sender: '示例甲', text: '示例反馈', at: '2026-10-16T02:00:00.000Z', source: 'poll' };
    expect(s.events.insert(e)).toBe(true);
    expect(s.events.insert(e)).toBe(false);                       // 幂等
    expect(s.events.pending().length).toBe(1);
    s.events.markDispatched(['m1']);
    expect(s.events.pending().length).toBe(0);
    expect(s.events.countSince('group:c1', '2026-10-16T00:00:00.000Z')).toBe(1);
  });

  test('锚点：每日序号 + 按 ext_id 查 + 更新往来', () => {
    const s = openStore(':memory:');
    const id1 = `anchor-2026-10-16-00${s.anchors.nextSeq('2026-10-16')}`;
    expect(id1).toBe('anchor-2026-10-16-001');
    const a = s.anchors.insert({
      id: id1, created_at: 'x', updated_at: 'x', consumer: 'ledger', strength: 'strong',
      needs_decision: true, title: 't', status: 'open', scope: 'self', ext_id: 'msg-1', replies: [],
    });
    expect(a.id).toBe(id1);
    expect(s.anchors.byExtId('msg-1').id).toBe(id1);
    const up = s.anchors.update(id1, { status: 'answered', replies: [{ extId: 'msg-2', direction: 'in', text: 'hi', at: 'x' }] });
    expect(up.status).toBe('answered');
    expect(up.replies.length).toBe(1);
  });

  test('消费者：upsert 幂等 + 只列启用的', () => {
    const s = openStore(':memory:');
    s.consumers.upsert({ name: 'ledger', targets: ['self', 'group:c1'], keywords: null, batch_window: 60, on_event: 'echo' });
    s.consumers.upsert({ name: 'ledger', targets: ['self'], keywords: ['x'], batch_window: 30, on_event: 'echo2' });
    const c = s.consumers.byName('ledger');
    expect(c.targets).toEqual(['self']);
    expect(c.batch_window).toBe(30);
    expect(s.consumers.all().length).toBe(1);
    s.consumers.upsert({ name: 'off', targets: ['*'], on_event: 'echo', enabled: false });
    expect(s.consumers.all().length).toBe(1);
    expect(s.consumers.all({ enabledOnly: false }).length).toBe(2);
  });
});
