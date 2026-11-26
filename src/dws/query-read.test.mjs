/**
 * P2-1：读类查询补口（chatList / directMessages / atMe）+ dws→hub 退出码映射
 * 设计：docs/design.md（P2-0 实测已回填 docs/design.md）
 * 不联网：假 dws 记录 argv 并回预设 JSON
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { atMe, chatList, directMessages, mapDwsExit } from './query.mjs';

function fakeDws(body, code = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-dws-p21-'));
  const log = join(dir, 'argv.log');
  const bin = join(dir, 'dws.sh');
  writeFileSync(bin, `#!/bin/bash\necho "$@" >> ${log}\necho '${JSON.stringify(body)}'\nexit ${code}\n`);
  chmodSync(bin, 0o755);
  return { bin, argv: () => (readFileSync(log, 'utf8').trim().split('\n').pop() || '') };
}

/** 任意脚本（用于 stdout/stderr 分流、噪声输出等）。 */
function fakeDwsScript(script, code = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-dws-script-'));
  const bin = join(dir, 'dws.sh');
  writeFileSync(bin, `#!/bin/bash\n${script}\nexit ${code}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

describe('query.chatList', () => {
  test('argv：+chat-list --types --page-all --page-limit；返回 conversations + complete', async () => {
    const f = fakeDws({ conversations: [{ openConversationId: 'cid1', name: '群A' }], complete: true });
    const r = await chatList({ types: ['group', 'p2p'], pageAll: true, bin: f.bin });
    expect(r.complete).toBe(true);
    expect(r.conversations[0].openConversationId).toBe('cid1');
    const a = f.argv();
    expect(a).toContain('+chat-list');
    expect(a).toContain('--types group,p2p');
    expect(a).toContain('--page-all');
    expect(a).toMatch(/--page-limit \d+/);
  });

  test('pageSize 越界（>100）→ 参数错误（hub code 2）', async () => {
    const f = fakeDws({ conversations: [] });
    await expect(chatList({ pageSize: 500, bin: f.bin })).rejects.toMatchObject({ code: 2 });
  });
});

describe('query.directMessages', () => {
  test('argv：--user + --time + --forward + --page-all（无 --start/--end）', async () => {
    const f = fakeDws({ messages: [{ messageId: 'm1', createTime: '2026-11-10T01:00:00Z' }], complete: true });
    const r = await directMessages({ user: 'u1', since: '2026-11-09T00:00:00Z', bin: f.bin });
    expect(r.complete).toBe(true);
    expect(r.messages[0].messageId).toBe('m1');
    const a = f.argv();
    expect(a).toContain('+messages-list-direct');
    expect(a).toContain('--user u1');
    expect(a).toContain('--forward');
    expect(a).toContain('--page-all');
    expect(a).not.toContain('--start');
    expect(a).not.toContain('--end');
  });

  test('缺 user/openId 或缺 since → 参数错误（code 2）', async () => {
    const f = fakeDws({ messages: [] });
    await expect(directMessages({ since: '2026-11-09T00:00:00Z', bin: f.bin })).rejects.toMatchObject({ code: 2 });
    await expect(directMessages({ user: 'u1', bin: f.bin })).rejects.toMatchObject({ code: 2 });
  });

  test('两个目标同时给 → 参数错误（互斥）', async () => {
    const f = fakeDws({ messages: [] });
    await expect(directMessages({ user: 'u1', openDingTalkId: 'o1', since: '2026-11-09T00:00:00Z', bin: f.bin }))
      .rejects.toMatchObject({ code: 2 });
  });

  test('forward=false → 显式 --forward=false（不省 flag，防静默反向）', async () => {
    const f = fakeDws({ messages: [], complete: true });
    await directMessages({ user: 'u1', since: '2026-11-09T00:00:00Z', forward: false, bin: f.bin });
    const a = f.argv();
    expect(a).toContain('--forward=false');
  });

  test('since >= end（两者都可解析）→ 参数错误（code 2，不可重试）', async () => {
    const f = fakeDws({ messages: [] });
    // 相等
    await expect(directMessages({ user: 'u1', since: '2026-11-09T00:00:00Z', end: '2026-11-09T00:00:00Z', bin: f.bin }))
      .rejects.toMatchObject({ code: 2, retryable: false });
    // 颠倒
    await expect(directMessages({ user: 'u1', since: '2026-11-10T00:00:00Z', end: '2026-11-09T00:00:00Z', bin: f.bin }))
      .rejects.toMatchObject({ code: 2, retryable: false });
  });

  test('since/end 不可解析 → 不拦（交给 dws 校验，避免误伤时间格式差异）', async () => {
    const f = fakeDws({ messages: [], complete: true });
    const r = await directMessages({ user: 'u1', since: 'not-a-time', end: 'also-not', bin: f.bin });
    expect(r.messages).toEqual([]);
  });
});

describe('query.atMe', () => {
  test('argv：+search-msg --at-me --days 7 --page-all（默认窗口显式传入）', async () => {
    const f = fakeDws({ messages: [{ messageId: 'm2' }], complete: true });
    const r = await atMe({ bin: f.bin });
    expect(r.messages[0].messageId).toBe('m2');
    const a = f.argv();
    expect(a).toContain('+search-msg');
    expect(a).toContain('--at-me');
    expect(a).toContain('--days 7');
    expect(a).toContain('--page-all');
  });

  test('senders 收窄 → --senders', async () => {
    const f = fakeDws({ messages: [] });
    await atMe({ senders: ['o1'], bin: f.bin });
    expect(f.argv()).toContain('--senders o1');
  });

  test('同时给 chatId 与 senders → 参数错误（互斥，不猜）', async () => {
    const f = fakeDws({ messages: [] });
    await expect(atMe({ chatId: 'cidX', senders: ['o1'], bin: f.bin })).rejects.toMatchObject({ code: 2 });
  });

  test('上游失败 + stdout 空数组 → 抛上游失败（code 3），不得伪装成空结果', async () => {
    const f = fakeDws({ error: { category: 'api', reason: 'rate_limited' }, messages: [] }, 1);
    await expect(atMe({ bin: f.bin })).rejects.toMatchObject({ code: 3, retryable: true });
  });

  test('stopReason=page_limit → complete=false（与 chatList / directMessages 同口径）', async () => {
    const f = fakeDws({ messages: [{ messageId: 'm1' }], complete: true, stopReason: 'page_limit' });
    const r = await atMe({ bin: f.bin });
    expect(r.complete).toBe(false);
    expect(r.stopReason).toBe('page_limit');
  });

  test('无 stopReason → complete 按分页语义推断，stopReason 回显 null', async () => {
    const f = fakeDws({ messages: [{ messageId: 'm1' }] });
    const r = await atMe({ bin: f.bin });
    expect(r.complete).toBe(true);
    expect(r.stopReason).toBe(null);
  });
});

describe('query.unwrapMapped 抢救解析门槛', () => {
  test('非 0 但 stdout 有非空数组（无 error 信封，stopReason=pagination_error）→ 抢救，且必须标 complete=false', async () => {
    // 真实坑：`+chat-list --page-all` 翻到尽头 exit 1，但 stdout 是完整 JSON（只有 stopReason，没有 error 信封）
    const f = fakeDws({ conversations: [{ openConversationId: 'cid1' }], stopReason: 'pagination_error' }, 1);
    const r = await chatList({ bin: f.bin });
    expect(r.conversations[0].openConversationId).toBe('cid1');
    expect(r.complete).toBe(false);
    expect(r.stopReason).toBe('pagination_error');
  });

  test('非 0 + 空数组（chatList / directMessages）→ 抛 code 3', async () => {
    const list = fakeDws({ error: { category: 'api', reason: 'rate_limited' }, conversations: [] }, 1);
    await expect(chatList({ bin: list.bin })).rejects.toMatchObject({ code: 3 });
    const direct = fakeDws({ error: { category: 'api', reason: 'rate_limited' }, messages: [] }, 1);
    await expect(directMessages({ user: 'u1', since: '2026-11-09T00:00:00Z', bin: direct.bin }))
      .rejects.toMatchObject({ code: 3 });
  });

  test('非 0 + 信封带非空 error + **非空数组** → 不许抢救，按 error 判失败（code 3）', async () => {
    const list = fakeDws({ error: { code: 500, message: 'boom' }, conversations: [{ openConversationId: 'cid1' }] }, 1);
    await expect(chatList({ bin: list.bin })).rejects.toMatchObject({ code: 3, retryable: true });
    const direct = fakeDws({ error: { code: 500, message: 'boom' }, messages: [{ messageId: 'm1' }] }, 1);
    await expect(directMessages({ user: 'u1', since: '2026-11-09T00:00:00Z', bin: direct.bin }))
      .rejects.toMatchObject({ code: 3, retryable: true });
  });
});

describe('stderr 兜底解析（坑 1）', () => {
  test('stdout 噪声 + stderr 是合法 JSON → 正常解析（不判失败）', async () => {
    const f = fakeDwsScript(
      "echo 'paging 3/20 ...'; echo '{\"conversations\":[{\"openConversationId\":\"cid9\"}]}' >&2",
    );
    const r = await chatList({ bin: f });
    expect(r.conversations[0].openConversationId).toBe('cid9');
  });

  test('stderr 也没有 JSON（exit 0）→ exit 0 也不放过：抛 code 3 且 retryable=true', async () => {
    const f = fakeDwsScript("echo 'paging 3/20 ...'; echo 'oops' >&2");
    await expect(chatList({ bin: f })).rejects.toMatchObject({ code: 3, retryable: true });
    await expect(directMessages({ user: 'u1', since: '2026-11-09T00:00:00Z', bin: f }))
      .rejects.toMatchObject({ code: 3, retryable: true });
  });
});

describe('mapDwsExit：dws 退出码 → hub 契约码（禁止透传）', () => {
  test('3 = validation → hub 2（不可重试）', () => {
    expect(mapDwsExit({ code: 3 })).toMatchObject({ code: 2, retryable: false });
  });
  test('1 = api 业务错误 → hub 3（可重试由调用方定）', () => {
    expect(mapDwsExit({ code: 1 })).toMatchObject({ code: 3 });
  });
  test('鉴权类错误 → hub 4', () => {
    expect(mapDwsExit({ code: 1, data: { error: { category: 'auth' } } })).toMatchObject({ code: 4, retryable: false });
  });
  test('0 → hub 0', () => {
    expect(mapDwsExit({ code: 0 })).toMatchObject({ code: 0 });
  });
  test('2 = CLI 自身 catch 哨兵 → hub 3 且**不自动重试**（区别于 code 1）', () => {
    expect(mapDwsExit({ code: 2 })).toMatchObject({ code: 3, retryable: false });
  });
  test('null = 超时 / spawn 失败 → hub 3 可重试', () => {
    expect(mapDwsExit({ code: null })).toMatchObject({ code: 3, retryable: true });
  });
  test('exit 0 但信封自报失败（success:false / ok:false）→ hub 3，不得当成功', () => {
    expect(mapDwsExit({ code: 0, data: { success: false, error: { category: 'api' } } }))
      .toMatchObject({ code: 3, retryable: true });
    expect(mapDwsExit({ code: 0, data: { ok: false } })).toMatchObject({ code: 3 });
    expect(mapDwsExit({ code: 0, data: { error: { category: 'validation' } } }))
      .toMatchObject({ code: 2, retryable: false });
  });
});

describe('假成功（exit 0 + success:false）与页数上限', () => {
  test('exit 0 + {success:false, conversations:[]} → chatList 抛 code 3（不伪装空结果）', async () => {
    const f = fakeDws({ success: false, conversations: [] }, 0);
    await expect(chatList({ bin: f.bin })).rejects.toMatchObject({ code: 3 });
  });

  test('exit 0 + {success:false, messages:[…]} → **不抢救**，抛 code 3', async () => {
    const f = fakeDws({ success: false, messages: [{ messageId: 'm1' }] }, 0);
    await expect(directMessages({ user: 'u1', since: '2026-11-09T00:00:00Z', bin: f.bin }))
      .rejects.toMatchObject({ code: 3 });
  });

  test('exit 0 但信封带非空 error（dwsJson 会判 ok=true）→ 仍按上游失败抛 code 3', async () => {
    const f = fakeDws({ error: { category: 'api', reason: 'rate_limited' }, messages: [] }, 0);
    await expect(atMe({ bin: f.bin })).rejects.toMatchObject({ code: 3 });
  });

  test('chatList pageLimit 超过 20 页 → 参数错误（hub code 2）', async () => {
    const f = fakeDws({ conversations: [] });
    await expect(chatList({ pageAll: true, pageLimit: 21, bin: f.bin })).rejects.toMatchObject({ code: 2 });
  });

  test('stopReason=page_limit → complete=false（打满页数不算完整）', async () => {
    const f = fakeDws({ conversations: [{ openConversationId: 'cid1' }], complete: true, stopReason: 'page_limit' });
    const r = await chatList({ bin: f.bin });
    expect(r.complete).toBe(false);
    expect(r.stopReason).toBe('page_limit');
  });
});

describe('query.directMessages 窗口语义（end）', () => {
  test('forward=false + end → --time = end（起点=上界，向过去拉）', async () => {
    const f = fakeDws({ messages: [], complete: true });
    await directMessages({ user: 'u1', since: '2026-11-08T00:00:00Z', end: '2026-11-09T00:00:00Z', forward: false, bin: f.bin });
    const a = f.argv();
    expect(a).toContain('--time 2026-11-09T00:00:00Z');
    expect(a).toContain('--forward=false');
  });

  test('forward=true + end → --time = since，结果按 at <= end 客户端过滤', async () => {
    const f = fakeDws({
      messages: [{ messageId: 'old', createTime: '2026-11-09T05:00:00Z' }, { messageId: 'new', createTime: '2026-11-10T05:00:00Z' }],
      complete: true,
    });
    const r = await directMessages({ user: 'u1', since: '2026-11-09T00:00:00Z', end: '2026-11-09T12:00:00Z', bin: f.bin });
    expect(f.argv()).toContain('--time 2026-11-09T00:00:00Z');
    expect(r.messages.map((m) => m.messageId)).toEqual(['old']);
  });
});
