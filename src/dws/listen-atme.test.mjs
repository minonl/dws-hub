/**
 * `atme` 通道（docs/design.md）：@我 不是 scope，靠 `+search-msg --at-me` 权威轮询，
 * 生产者必须写 `event.meta.mentionMe = true`（否则分派永远不投递）。
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { atMeScope, atmeQueryOf, isMentionMeMessage, normalizeMessage, pullAtMe } from './listen.mjs';
import { openStore } from '../hub/store.mjs';
import { pendingFor } from '../hub/dispatch.mjs';

function fakeDws(body, code = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-dws-atme-'));
  const log = join(dir, 'argv.log');
  const bin = join(dir, 'dws.sh');
  writeFileSync(bin, `#!/bin/bash\necho "$@" >> ${log}\necho '${JSON.stringify(body)}'\nexit ${code}\n`);
  chmodSync(bin, 0o755);
  return { bin, argv: () => (readFileSync(log, 'utf8').trim().split('\n').pop() || '') };
}

const atMeMsg = (id = 'msgA', cid = 'cidA') => ({
  messageId: id,
  conversationId: cid,
  sender: '李示例',
  senderId: 'u1',
  text: '@王示例 今晚还有流量高峰吗？',     // 真实 @我 渲染成昵称（文本里没有「@我」）
  createTime: '2026-11-10 14:56:43',
});

describe('normalizeMessage / mentionMe 生产者', () => {
  test('消息自带 @我 标记 → meta.mentionMe=true', () => {
    const e = normalizeMessage({ messageId: 'm1', text: '看下', isAtMe: true }, { scope: 'group:cid1', source: 'poll' });
    expect(e.meta).toMatchObject({ mentionMe: true });
    expect(isMentionMeMessage({ isAtMe: true })).toBe(true);
  });

  test('文本兜底：独立 `@我` 命中；`@我们` 不误判', () => {
    const hit = normalizeMessage({ messageId: 'm2', text: '@我 看一下' }, { scope: 'group:cid1', source: 'scan' });
    expect(hit.meta?.mentionMe).toBe(true);
    const miss = normalizeMessage({ messageId: 'm3', text: '@我们 看下' }, { scope: 'group:cid1', source: 'scan' });
    expect(miss.meta?.mentionMe).toBeUndefined();
  });

  test('显式 mentionMe:false 可关闭兜底（非 @我 通道）', () => {
    const e = normalizeMessage({ messageId: 'm4', text: '@我 看一下' }, { scope: 'group:cid1', source: 'poll', mentionMe: false });
    expect(e.meta?.mentionMe).toBeUndefined();
  });
});

describe('atme 选择器编译', () => {
  test('atme:* / atme:chat:<cid> / atme:user:<uid> → query.atMe 收窄入参', () => {
    expect(atmeQueryOf('atme:*')).toEqual({});
    expect(atmeQueryOf('atme:chat:cid1')).toEqual({ chatId: 'cid1' });
    expect(atmeQueryOf('atme:user:u1')).toEqual({ senders: ['u1'] });
    expect(atmeQueryOf('group:cid1')).toBeNull();
  });

  test('事件 scope 保留真实会话（已知 singleChat 时按单聊）', () => {
    expect(atMeScope({ conversationId: 'cid1' })).toBe('group:cid1');
    expect(atMeScope({ singleChat: true, senderId: 'u1', conversationId: 'cid1' })).toBe('direct:u1');
  });
});

describe('pullAtMe / 端到端投递', () => {
  test('@我 消息入库并带 mentionMe=true → atme 消费者可收到', async () => {
    const f = fakeDws({ messages: [atMeMsg()], complete: true });
    const store = openStore(':memory:');
    store.consumers.upsert({ name: 'reviewer-atme', targets: ['atme:*'], batch_window: 0, on_event: 'true' });

    const r = await pullAtMe(store, { targets: ['atme:*'], bin: f.bin });
    expect(r.inserted).toBe(1);
    expect(r.insertedEvents[0].meta).toMatchObject({ mentionMe: true, conversation_id: 'cidA' });
    expect(r.insertedEvents[0].scope).toBe('group:cidA');
    expect(pendingFor(store, store.consumers.byName('reviewer-atme')).length).toBe(1);
    expect(f.argv()).toContain('+search-msg --at-me');
    expect(f.argv()).toContain('--days 7');
  });

  test('幂等：同一条 @我 消息不重复入库（ext_id 去重）', async () => {
    const f = fakeDws({ messages: [atMeMsg()], complete: true });
    const store = openStore(':memory:');
    await pullAtMe(store, { targets: ['atme:*'], bin: f.bin });
    const again = await pullAtMe(store, { targets: ['atme:*'], bin: f.bin });
    expect(again.inserted).toBe(0);
    expect(again.updated).toBe(0);
  });

  test('poll/scan 先入库（无 mentionMe）→ atme 轮询补标记，订阅不饿死', async () => {
    const f = fakeDws({ messages: [atMeMsg()], complete: true });
    const store = openStore(':memory:');
    store.consumers.upsert({ name: 'reviewer-atme', targets: ['atme:*'], batch_window: 0, on_event: 'true' });
    // 模拟 scope 轮询先写入（同一 ext_id，无 mentionMe）
    store.events.insert(normalizeMessage(atMeMsg(), { scope: 'group:cidA', source: 'poll' }));
    expect(pendingFor(store, store.consumers.byName('reviewer-atme')).length).toBe(0);

    const r = await pullAtMe(store, { targets: ['atme:*'], bin: f.bin });
    expect(r.inserted).toBe(0);
    expect(r.updated).toBe(1);
    expect(store.events.byExtId('msgA').meta).toMatchObject({ mentionMe: true });
    expect(pendingFor(store, store.consumers.byName('reviewer-atme')).length).toBe(1);
  });

  test('上游失败不抛（tick 不因 @我 通道失败而中断）', async () => {
    const f = fakeDws({ error: { message: 'boom' } }, 1);
    const store = openStore(':memory:');
    const r = await pullAtMe(store, { targets: ['atme:*'], bin: f.bin });
    expect(r.inserted).toBe(0);
    expect(r.incomplete).toEqual(['atme:*']);
  });
});
