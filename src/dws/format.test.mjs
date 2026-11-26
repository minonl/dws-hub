import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_SUMMARY_CHARS,
  buildNotifyBody,
  charLen,
  checkNotify,
  validateNotifyBody,
} from './format.mjs';

const RID = 'ExampleOpenId0123456789ABCDEF';
const U1 = 'https://code.example.com/group/repo/-/merge_requests/42';
const U2 = 'https://code.example.com/group/other/-/merge_requests/43';

test('群聊单链接 → 合规正文（@ 在前 + 链接独占一行）', () => {
  const body = buildNotifyBody({ reviewerId: RID, summary: '示例修复', urls: [U1] });
  assert.equal(body, `<@${RID}> 示例修复\n${U1}`);
});

test('群聊一批多链接 → 逐行罗列，无空行', () => {
  const body = buildNotifyBody({ reviewerId: RID, summary: '示例收敛', urls: [U1, U2] });
  assert.deepEqual(body.split('\n'), [`<@${RID}> 示例收敛`, U1, U2]);
});

test('单聊 → 第 1 行只有概要，不生成 <@id>', () => {
  const body = buildNotifyBody({ summary: '单聊验证', urls: [U1], dm: true });
  assert.equal(body, `单聊验证\n${U1}`);
  assert.ok(!body.includes('<@'));
});

test('概要超 15 字 → 抛错（中文按字符算）', () => {
  const long = '这是一个特别特别长的修改概要超过十五个字了';
  assert.ok(charLen(long) > MAX_SUMMARY_CHARS);
  assert.throws(() => buildNotifyBody({ reviewerId: RID, summary: long, urls: [U1] }), /15 字/);
});

test('中文 13 字 ≤ 15 → 通过（locale 无关）', () => {
  const s = '模板 pnpm 并发限 4'; // 13 字符
  assert.equal(charLen(s), 13);
  assert.doesNotThrow(() => buildNotifyBody({ reviewerId: RID, summary: s, urls: [U1] }));
});

test('含客套语 → 抛错', () => {
  assert.throws(
    () => buildNotifyBody({ reviewerId: RID, summary: '麻烦看看这个', urls: [U1] }),
    /客套语/,
  );
});

test('正文含空行 → 校验失败（破坏钉钉渲染）', () => {
  const r = validateNotifyBody(`<@${RID}> 概要\n\n${U1}`);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /空行/);
});

test('链接行不纯 → 校验失败', () => {
  const r = validateNotifyBody(`<@${RID}> 概要\n看这里 ${U1}`);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /纯 URL/);
});

test('单聊正文带 <@id> → 校验失败（占位符会原样显示）', () => {
  const r = validateNotifyBody(`<@${RID}> 概要\n${U1}`, { dm: true });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /占位符/);
});

test('@ 占位符 ID 与 reviewerId 不一致 → 校验失败', () => {
  const r = validateNotifyBody(`<@OTHERID> 概要\n${U1}`, { reviewerId: RID });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /不一致/);
});

test('非 GitLab MR 链接 → 仅警告不阻断', () => {
  const r = checkNotify({ reviewerId: RID, summary: '验证', urls: ['https://example.com/x'] });
  assert.equal(r.ok, true);
  assert.equal(r.warnings.length, 1);
});
