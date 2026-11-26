/**
 * query/send 能力补口（迁移 P0 前置）—— 不联网：假 dws 记录 argv 后回预设 JSON
 * 设计：docs/design.md
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chatMessages, chatSearch, searchMessages } from './query.mjs';
import { sendChat, sendReply } from './send.mjs';

/** 造一个假 dws：把 argv 写进 $FAKE_DWS_LOG，stdout 回 `body` */
function fakeDws(bodyObj) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-dws-'));
  const log = join(dir, 'argv.log');
  const bin = join(dir, 'dws.sh');
  writeFileSync(bin, `#!/bin/bash\necho "$@" >> ${log}\ncat <<'EOF'\n${JSON.stringify(bodyObj)}\nEOF\n`);
  chmodSync(bin, 0o755);
  return { bin, argv: () => (readFileSync(log, 'utf8').trim().split('\n').pop() || '') };
}

describe('query.chatMessages 参数面', () => {
  test('--user（按单聊 userId 拉）', async () => {
    const f = fakeDws({ messages: [] });
    await chatMessages({ user: 'uid_demo_0001', limit: 5, bin: f.bin });
    expect(f.argv()).toContain('--user uid_demo_0001');
  });

  test('--end / --order / --page-all 透传', async () => {
    const f = fakeDws({ messages: [] });
    await chatMessages({ group: 'cidX', end: '2026-11-09T00:00:00Z', order: 'asc', pageAll: true, bin: f.bin });
    const a = f.argv();
    expect(a).toContain('--end 2026-11-09T00:00:00Z');
    expect(a).toContain('--order asc');
    expect(a).toContain('--page-all');
  });
});

describe('query.chatSearch / searchMessages', () => {
  test('chatSearch：群名 → chats', async () => {
    const f = fakeDws({ chats: [{ name: '示例项目群', openConversationId: 'cidA' }] });
    const chats = await chatSearch({ query: '示例项目群', bin: f.bin });
    expect(chats[0].openConversationId).toBe('cidA');
    expect(f.argv()).toContain('+chat-search');
    expect(f.argv()).toContain('--query 示例项目群');
  });

  test('searchMessages：群内关键词', async () => {
    const f = fakeDws({ messages: [{ messageId: 'm1' }] });
    const msgs = await searchMessages({ group: 'cidA', query: '示例关键词', bin: f.bin });
    expect(msgs[0].messageId).toBe('m1');
    expect(f.argv()).toContain('+search-msg');
    expect(f.argv()).toContain('--group cidA');
  });
});

describe('send 补口', () => {
  test('sendChat 支持 @（占位符 + --at-open-dingtalk-ids）', async () => {
    const f = fakeDws({ ok: true });
    await sendChat('cidA', '你好 <@u1>', { ats: ['u1'], bin: f.bin });
    expect(f.argv()).toContain('--at-open-dingtalk-ids u1');
  });

  test('sendChat 缺占位符必须报错（不发）', async () => {
    const f = fakeDws({ ok: true });
    await expect(sendChat('cidA', '你好', { ats: ['u1'], bin: f.bin })).rejects.toThrow(/占位符/);
  });

  test('sendReply：单聊不传 --group（DM 用 direct 模式）', async () => {
    const f = fakeDws({ ok: true });
    await sendReply('cidDM', 'msgX', '已开通', { bin: f.bin, direct: true });
    const a = f.argv();
    expect(a).toContain('--ref-msg-id msgX');
    expect(a).not.toContain('--group');
  });
});
