import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildEditArgs,
  buildEditContent,
  contentToText,
  editAndVerify,
  editMessage,
  findLiteralMentions,
  readMessage,
} from './edit.mjs';

/**
 * 假 `dws`：只覆盖 edit / list-by-ids 两条命令，不触网。
 * 用环境变量 `FAKE_CONTENT` 控制读回的正文（默认干净）。
 */
const dir = mkdtempSync(join(tmpdir(), 'dws-edit-fake-'));
const FAKE = join(dir, 'dws');
writeFileSync(
  FAKE,
  `#!/bin/sh
case "$*" in
  *"message edit"*) echo '{"result":{"editStatus":"SUCCESS","openMessageId":"m1"}}' ;;
  *"list-by-ids"*) echo "{\\"result\\":{\\"messages\\":[{\\"messageId\\":\\"m1\\",\\"content\\":\\"\${FAKE_CONTENT:-收到~正文}\\"}]}}" ;;
  *) echo '{"error":"unknown"}' >&2; exit 1 ;;
esac
`,
);
chmodSync(FAKE, 0o755);

test('buildEditArgs：使用 --content JSON（不带 title 时不塞空 title）', () => {
  const args = buildEditArgs('cid1', 'm1', '新正文');
  assert.deepEqual(args.slice(0, 6), ['chat', 'message', 'edit', '--conversation-id', 'cid1', '--message-id']);
  const content = args[args.indexOf('--content') + 1];
  assert.deepEqual(JSON.parse(content), { text: '新正文' });
  assert.ok(args.includes('--yes'));
});

test('buildEditArgs：显式 title', () => {
  const args = buildEditArgs('cid1', 'm1', '新正文', { title: '标题' });
  assert.deepEqual(JSON.parse(args[args.indexOf('--content') + 1]), { title: '标题', text: '新正文' });
});

test('buildEditArgs：拒绝字面量 <@id> 占位符（2026-11-13 事故）', () => {
  assert.throws(() => buildEditArgs('cid1', 'm1', '<@openIdXxx> 正文'), /字面量占位符/);
});

test('buildEditArgs：缺会话/消息/空正文 → 明确报错', () => {
  assert.throws(() => buildEditArgs('', 'm1', 'x'), /--conversation-id/);
  assert.throws(() => buildEditArgs('cid1', '', 'x'), /--message-id/);
  assert.throws(() => buildEditArgs('cid1', 'm1', '   '), /正文不能为空/);
});

test('findLiteralMentions：只认 <@…> 形状，不误伤邮箱/普通文本', () => {
  assert.deepEqual(findLiteralMentions('a@b.com'), []);
  assert.deepEqual(findLiteralMentions('前 <@openId1> 后'), ['<@openId1>']);
});

test('contentToText：markdown JSON 与纯文本都归一', () => {
  assert.equal(contentToText(JSON.stringify({ title: 't', text: '正文' })), '正文');
  assert.equal(contentToText('纯文本'), '纯文本');
});

test('editMessage + readMessage：编辑成功、读回无占位符', async () => {
  const edit = await editMessage('cid1', 'm1', '新正文', { bin: FAKE });
  assert.equal(edit.ok, true);
  const read = await readMessage('m1', { bin: FAKE });
  assert.equal(read.ok, true);
  assert.equal(read.hasLiteralMention, false);
  assert.equal(read.text, '收到~正文');
});

test('editAndVerify：读回含字面量占位符 → 判定失败（不撤回重发）', async () => {
  process.env.FAKE_CONTENT = '<@openId1> 旧正文';
  try {
    const r = await editAndVerify('cid1', 'm1', '新正文', { bin: FAKE });
    assert.equal(r.ok, false);
    assert.equal(r.verify.hasLiteralMention, true);
  } finally {
    delete process.env.FAKE_CONTENT;
  }
});

test('buildEditContent：字符串内容不做转义破坏（中文/引号原样）', () => {
  const text = '收到～「引号」与 <div> 标签';
  assert.equal(JSON.parse(buildEditContent(text)).text, text);
});
