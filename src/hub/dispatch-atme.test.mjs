/** atme 选择器分派（docs/design.md：domains.mentionMe / event.meta.mentionMe） */
import { describe, expect, test } from 'bun:test';
import { atmeTargets, pendingFor, shouldDeliver } from './dispatch.mjs';
import { openStore } from './store.mjs';
import { normalizeMessage } from '../dws/listen.mjs';

const consumer = { name: 'reviewer-atme', targets: ['atme:*'], domains: { scopes: ['atme:*'], mentionMe: true } };

describe('shouldDeliver / atme', () => {
  test('@我 事件 → 投递', () => {
    const ev = { scope: 'group:cid1', outbound: false, meta: { mentionMe: true }, text: '@我 看一下' };
    expect(shouldDeliver(consumer, ev)).toBe(true);
  });

  test('非 @我 事件 → 不投递', () => {
    const ev = { scope: 'group:cid1', outbound: false, meta: { mentionMe: false }, text: '普通消息' };
    expect(shouldDeliver(consumer, ev)).toBe(false);
  });

  test('atme:chat:<cid> / atme:user:<uid> 收窄仍要求 @我', () => {
    const byChat = { name: 'c', domains: { scopes: ['atme:chat:cid1'], mentionMe: true } };
    expect(shouldDeliver(byChat, { scope: 'group:cid1', outbound: false, meta: { mentionMe: true } })).toBe(true);
    expect(shouldDeliver(byChat, { scope: 'group:cid2', outbound: false, meta: { mentionMe: true } })).toBe(false);
    expect(shouldDeliver(byChat, { scope: 'group:cid1', outbound: false, meta: {} })).toBe(false);
    const byUser = { name: 'u', domains: { scopes: ['atme:user:u1'], mentionMe: true } };
    expect(shouldDeliver(byUser, { scope: 'group:cid1', sender: 'u1', outbound: false, meta: { mentionMe: true } })).toBe(true);
    expect(shouldDeliver(byUser, { scope: 'group:cid1', sender: 'u2', outbound: false, meta: { mentionMe: true } })).toBe(false);
  });
});

describe('atme / 端到端（生产者 → 分派）', () => {
  test('normalizeMessage 产出的 @我 事件能被 atme 消费者取到（不再是断链）', () => {
    const store = openStore(':memory:');
    store.consumers.upsert({ name: 'reviewer-atme', targets: ['atme:*'], batch_window: 0, on_event: 'true' });
    const ev = normalizeMessage(
      { messageId: 'm1', sender: 'u1', text: '@我 看一下', createTime: '2026-11-10 10:00:00', conversationId: 'cid1' },
      { scope: 'group:cid1', source: 'scan' },
    );
    store.events.insert(ev);
    expect(pendingFor(store, store.consumers.byName('reviewer-atme')).length).toBe(1);
  });

  test('atmeTargets：只收 atme 选择器（普通 scope 不算）', () => {
    const store = openStore(':memory:');
    store.consumers.upsert({ name: 'a', targets: ['group:cid1', 'atme:*', 'atme:chat:cid2'], batch_window: 0, on_event: 'true' });
    store.consumers.upsert({ name: 'b', targets: ['self'], batch_window: 0, on_event: 'true' });
    expect(atmeTargets(store).sort()).toEqual(['atme:*', 'atme:chat:cid2']);
  });
});
