#!/usr/bin/env bun
/**
 * send.test.mjs —— L1 发送姿势的单测（不真发消息：用 fakeBin 桩）
 * 覆盖：① group 无 @ ② group 有 @（占位符必须成对）③ reply 禁止正文写占位符
 *       ④ 读回校验能发现字面量占位符 ⑤ 参数校验
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'dws-hub-send-test-'));
/** 桩：记录调用参数，返回固定 JSON */
function fakeBin(replyText = '') {
  const messages = typeof replyText === 'string'
    ? [{ createTime: '2026-10-19 15:00:00', sender: 'X', text: replyText, messageId: 'm1' }]
    : replyText;
  const log = join(dir, `calls-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(log, '[]');
  const script = join(dir, `fake-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(script, `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs';
const log = ${JSON.stringify(log)};
const calls = JSON.parse(readFileSync(log, 'utf8'));
calls.push(process.argv.slice(2));
writeFileSync(log, JSON.stringify(calls));
const args = process.argv.slice(2);
if (args.includes('+chat-messages')) {
  console.log(JSON.stringify({ messages: ${JSON.stringify(messages)} }));
} else {
  console.log(JSON.stringify({ ok: true, data: { messageId: 'sent-1' } }));
}
`);
  const bin = join(dir, `bin-${Math.random().toString(36).slice(2)}`);
  writeFileSync(bin, `#!/bin/sh\nexec bun ${script} "$@"\n`, { mode: 0o755 });
  return { bin, calls: () => JSON.parse(readFileSync(log, 'utf8')) };
}

const { sendGroup, sendReply, verify, findLiteralMentions } = await import('./send.mjs');

describe('L1 发送姿势', () => {
  test('group 无 @ → 不带 at 参数', async () => {
    const { bin, calls } = fakeBin();
    await sendGroup('cid1', 'hello', [], { bin });
    const send = calls().find((c) => c.includes('+messages-send'));
    expect(send).toBeTruthy();
    expect(send.join(' ')).not.toContain('--at-open-dingtalk-ids');
  });

  test('group 有 @ → 必须同时带 --at 与占位符', async () => {
    const { bin, calls } = fakeBin();
    await sendGroup('cid1', '<@u1> 请看', ['u1'], { bin });
    const send = calls().find((c) => c.includes('+messages-send'));
    expect(send.join(' ')).toContain('--at-open-dingtalk-ids');
    expect(send.join(' ')).toContain('u1');
  });

  test('group 占位符缺失 → 直接拒绝（不发）', async () => {
    const { bin, calls } = fakeBin();
    await expect(sendGroup('cid1', '没有占位符', ['u1'], { bin })).rejects.toThrow(/占位符/);
    expect(calls().length).toBe(0);
  });

  test('reply 正文含占位符 → 拒绝（避免字面量）', async () => {
    const { bin, calls } = fakeBin();
    await expect(sendReply('cid1', 'ref1', '<@u1> 已处理', { bin })).rejects.toThrow(/占位符/);
    expect(calls().length).toBe(0);
  });

  test('reply 正常 → 不传 at、正文无 @', async () => {
    const { bin, calls } = fakeBin();
    await sendReply('cid1', 'ref1', '已处理', { bin });
    const reply = calls().find((c) => c.includes('+messages-reply'));
    expect(reply.join(' ')).toContain('--ref-msg-id');
    expect(reply.join(' ')).not.toContain('--at-open-dingtalk-ids');
  });

  test('读回校验：字面量占位符 → 返回 1', async () => {
    const { bin } = fakeBin('@张示例 <@ExampleOpenId0001> 你好');   // 模拟"发错了"的消息
    const code = await verify('cid1', { quiet: true, bin });
    expect(code).toBe(1);
  });

  test('读回校验：正常 @ → 返回 0', async () => {
    const { bin } = fakeBin('@张示例 你好');
    const code = await verify('cid1', { quiet: true, bin });
    expect(code).toBe(0);
  });

  test('findLiteralMentions 只挑出含 <@ 的消息', () => {
    const msgs = [{ text: '@张三 ok' }, { text: '<@u1> bad' }];
    expect(findLiteralMentions(msgs).length).toBe(1);
  });

describe('2026-11-10 加严：手写 @ / reply --at / 本次消息读回', () => {
  test('findPlainMentions：识别手写 @姓名，排除邮箱', async () => {
    const { findPlainMentions } = await import('./send.mjs');
    expect(findPlainMentions('@示例-张三 已修复')).toEqual(['@示例-张三']);
    expect(findPlainMentions('联系 ops@example.com 即可')).toEqual([]);
    expect(findPlainMentions('普通正文没有 at')).toEqual([]);
  });

  test('reply 正文手写 @姓名 → 拒绝（不发）', async () => {
    const { bin, calls } = fakeBin();
    await expect(sendReply('cid1', 'ref1', '@张三 已处理', { bin })).rejects.toThrow(/手写 @姓名/);
    expect(calls().length).toBe(0);
  });

  test('reply 手写 @ + --allow-plain-at → 放行（显式绕过）', async () => {
    const { bin, calls } = fakeBin();
    await sendReply('cid1', 'ref1', '他说 @张三 会跟进', { bin, allowPlainAt: true });
    expect(calls().some((c) => c.includes('+messages-reply'))).toBe(true);
  });

  test('verify(expectMessageId)：本次正常 + 历史有字面量 → 返回 0（不误判）', async () => {
    const { bin } = fakeBin([
      { createTime: '2026-11-10 15:02:46', sender: 'X', text: '<@OLD> 历史脏消息', messageId: 'old-1' },
      { createTime: '2026-11-10 16:29:25', sender: 'X', text: '@示例 已修复', messageId: 'cur-1' },
    ]);
    const code = await verify('cid1', { quiet: true, bin, expectMessageId: 'cur-1' });
    expect(code).toBe(0);
  });

  test('verify(expectMessageId)：本次含字面量 → 返回 1（只判本次）', async () => {
    const { bin } = fakeBin([
      { createTime: '2026-11-10 16:41:02', sender: 'X', text: '<@openId> 已修复', messageId: 'cur-2' },
    ]);
    const code = await verify('cid1', { quiet: true, bin, expectMessageId: 'cur-2' });
    expect(code).toBe(1);
  });

  test('send.mjs reply 传 --at → 退出 2（引用回复不支持 at）', () => {
    const { spawnSync } = require('node:child_process');
    const { bin } = fakeBin();
    const script = join(import.meta.dir, 'send.mjs');
    const r = spawnSync('bun', [script, 'reply', 'cid1', 'ref1', '已处理', '--at', 'u1'], {
      encoding: 'utf8',
      env: { ...process.env, DWS_BIN: bin },
      timeout: 30_000,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('引用回复不支持 --at');
  });
});
});
