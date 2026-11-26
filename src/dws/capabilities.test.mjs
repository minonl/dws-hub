import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { sendPersonalDing } from './ding.mjs';
import { leaveRecords, searchUsers, selfUser } from './lookup.mjs';
import { authStatus, chatMessages, recentConversations, searchAtMe } from './query.mjs';

/**
 * 用假 `dws` 可执行文件覆盖命令分支（不触网）。
 * 每个用例传 `bin: FAKE`。
 */
const dir = mkdtempSync(join(tmpdir(), 'dws-fake-'));
const FAKE = join(dir, 'dws');
writeFileSync(
  FAKE,
  `#!/bin/sh
case "$*" in
  *"contact user search"*) echo '{"result":[{"name":"张三","userId":"u1","openDingTalkId":"o1"}]}' ;;
  *"contact +me"*) echo '{"data":{"userId":"u1","name":"我"}}' ;;
  *"attendance approve list"*) echo '{"result":[{"subType":"年假"}]}' ;;
  *"auth status"*) echo '{"authenticated":true,"user_name":"我"}' ;;
  *"recent-conversations"*) echo '{"conversations":[{"conversationId":"c1","type":"direct"}]}' ;;
  *"chat-messages"*) echo '{"messages":[{"text":"hi"}]}' ;;
  *"search-msg"*) echo '{"messages":[{"text":"@我"}]}' ;;
  *"ding +send-personal"*) echo '{"success":true}' ;;
  *) echo '{"error":"unknown"}' >&2; exit 1 ;;
esac
`,
);
chmodSync(FAKE, 0o755);

test('lookup.searchUsers → 结果数组', async () => {
  const users = await searchUsers('张三', { bin: FAKE });
  assert.equal(users[0].userId, 'u1');
});

test('lookup.selfUser → data 解包', async () => {
  const me = await selfUser({ bin: FAKE });
  assert.equal(me.name, '我');
});

test('lookup.leaveRecords → 请假单数组；空 userIds 不调用', async () => {
  const recs = await leaveRecords({ userIds: ['u1'], date: '2026-11-06', bin: FAKE });
  assert.equal(recs[0].subType, '年假');
  assert.deepEqual(await leaveRecords({ userIds: [], date: '2026-11-06', bin: FAKE }), []);
});

test('query.authStatus → 登录态', async () => {
  const st = await authStatus({ bin: FAKE });
  assert.equal(st.user_name, '我');
});

test('query.recentConversations / chatMessages / searchAtMe', async () => {
  assert.equal((await recentConversations({ since: '2026-11-06T00:00:00Z', bin: FAKE }))[0].conversationId, 'c1');
  assert.equal((await chatMessages({ conversationId: 'c1', bin: FAKE }))[0].text, 'hi');
  assert.equal((await searchAtMe({ group: 'cid', days: 3, bin: FAKE }))[0].text, '@我');
});

test('ding.sendPersonalDing → success:true 判成功', async () => {
  const r = await sendPersonalDing({ openDingTalkId: 'o1', text: '测试', bin: FAKE });
  assert.equal(r.ok, true);
});

test('ding.sendPersonalDing 缺参 → 抛错（不再静默）', async () => {
  await assert.rejects(() => sendPersonalDing({ text: 'x', bin: FAKE }), /openDingTalkId/);
});
