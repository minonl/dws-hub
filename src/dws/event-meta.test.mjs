/** 事件载荷必须带身份与自发标记（P2-2b 前置） */
import { describe, expect, test } from 'bun:test';
import { normalizeMessage } from './listen.mjs';

describe('normalizeMessage / meta 身份字段', () => {
  test('senderId + messageAiSendFlag + conversationId 进入 meta', () => {
    const e = normalizeMessage(
      { messageId: 'm1', sender: 'alice', senderId: 'OPEN_ID_ALICE', conversationId: 'cid1', text: 'hi', messageAiSendFlag: 'DWS' },
      { scope: 'direct:uid_demo_0002', source: 'poll' },
    );
    expect(e.meta.senderId).toBe('OPEN_ID_ALICE');
    expect(e.meta.aiSendFlag).toBe('DWS');
    expect(e.meta.conversation_id).toBe('cid1');
    expect(e.sender).toBe('alice');
  });

  test('没有 senderId 时不臆造（不拿昵称兜底）', () => {
    const e = normalizeMessage({ messageId: 'm2', sender: '某人', text: 'x' }, { scope: 'self', source: 'self' });
    expect(e.meta?.senderId).toBeUndefined();
  });
});
