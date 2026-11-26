/**
 * send.sendReply 幂等键与身份透传（迁移 P0-2b 前置）—— 假 dws 记录 argv
 * 设计：docs/design.md
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sendChat, sendDirect, sendGroup, sendReply } from './send.mjs';

function fakeDws() {
  const dir = mkdtempSync(join(tmpdir(), 'fake-dws-reply-'));
  const log = join(dir, 'argv.log');
  const bin = join(dir, 'dws.sh');
  writeFileSync(bin, `#!/bin/bash\necho "$@" >> ${log}\ncat <<'EOF'\n{"ok":true,"messageId":"m-new"}\nEOF\n`);
  chmodSync(bin, 0o755);
  return { bin, argv: () => (readFileSync(log, 'utf8').trim().split('\n').pop() || '') };
}

/** 桩：dws 以「同幂等键重复」失败信封退出（stderr + code 1） */
function fakeDwsRepeated(message = "sendPersonalMessageByServerPush error: Request is repeated with uuid 'k1'") {
  const dir = mkdtempSync(join(tmpdir(), 'fake-dws-repeated-'));
  const bin = join(dir, 'dws.sh');
  const envelope = {
    ok: false,
    error: { category: 'api', reason: 'business_error', code: 1, server_error_code: '1001', message },
  };
  writeFileSync(bin, `#!/bin/bash\necho ${JSON.stringify(JSON.stringify(envelope))} >&2\nexit 1\n`);
  chmodSync(bin, 0o755);
  return { bin };
}

describe('sendReply / 幂等键', () => {
  test('调用方 uuid → --idempotency-key 用它（不再用时间戳）', async () => {
    const f = fakeDws();
    await sendReply('cidA', 'msgX', '已开通', { bin: f.bin, uuid: 'ug-reply-msgX' });
    expect(f.argv()).toContain('--idempotency-key ug-reply-msgX');
  });

  test('未给 uuid → 仍有默认幂等键（不以 undefined 出现）', async () => {
    const f = fakeDws();
    await sendReply('cidA', 'msgX', '已开通', { bin: f.bin });
    expect(f.argv()).toContain('--idempotency-key dws-hub-reply-');
  });
});

describe('sendReply / 身份透传', () => {
  test('默认 --as user（与历史调用一致）', async () => {
    const f = fakeDws();
    await sendReply('cidA', 'msgX', '已开通', { bin: f.bin });
    expect(f.argv()).toContain('--as user');
  });

  test('显式 as=bot 透传', async () => {
    const f = fakeDws();
    await sendReply('cidA', 'msgX', 'x', { bin: f.bin, as: 'bot' });
    expect(f.argv()).toContain('--as bot');
  });

  test('direct 模式下不出现 --group', async () => {
    const f = fakeDws();
    await sendReply('cidA', 'msgX', 'x', { bin: f.bin, direct: true, uuid: 'k1' });
    expect(f.argv()).not.toContain('--group');
    expect(f.argv()).toContain('--ref-msg-id msgX');
  });
});

describe('幂等命中 = 成功（duplicated，不重试）', () => {
  test("Request is repeated with uuid 'k1' → ok:true + duplicated + deduped，且不把 error 冒泡", async () => {
    const f = fakeDwsRepeated();
    const r = await sendReply('cidA', 'msgX', '已开通', { bin: f.bin, uuid: 'k1' });
    expect(r.ok).toBe(true);
    expect(r.duplicated).toBe(true);
    expect(r.deduped).toBe(true);           // 向后兼容别名
    expect(r.data?.error).toBeUndefined();
    expect(r.data?.repeated_error?.message).toContain('Request is repeated with uuid');
    expect(r.raw).toContain('Request is repeated with uuid');
  });

  test('大小写变体（request IS REPEATED with UUID）同样命中', async () => {
    const f = fakeDwsRepeated("request IS REPEATED with UUID 'k9'");
    const r = await sendReply('cidA', 'msgX', '已开通', { bin: f.bin, uuid: 'k9' });
    expect(r.ok).toBe(true);
    expect(r.duplicated).toBe(true);
    expect(r.raw).toContain('REPEATED');
  });

  test('四个入口都过归一：sendGroup / sendDirect / sendChat / sendReply', async () => {
    const cases = [
      ['sendGroup', (bin) => sendGroup('cidA', '<@u1> 已开通', ['u1'], { bin, uuid: 'k1' })],
      ['sendDirect', (bin) => sendDirect('u1', '已开通', { bin, uuid: 'k1' })],
      ['sendChat', (bin) => sendChat('cidA', '已开通', { bin, uuid: 'k1' })],
      ['sendReply', (bin) => sendReply('cidA', 'msgX', '已开通', { bin, uuid: 'k1' })],
    ];
    for (const [name, run] of cases) {
      const f = fakeDwsRepeated();
      const r = await run(f.bin);
      expect([name, r.ok]).toEqual([name, true]);
      expect([name, r.duplicated]).toEqual([name, true]);
      expect(r.raw).toContain('Request is repeated with uuid');
    }
  });

  test('其它业务错误仍判失败（不误伤）', async () => {
    const f = fakeDwsRepeated('group members limit exceeded');
    const r = await sendReply('cidA', 'msgX', '已开通', { bin: f.bin, uuid: 'k2' });
    expect(r.ok).toBe(false);
    expect(r.duplicated).toBeUndefined();
    expect(r.deduped).toBeUndefined();
  });

  test('只出现 repeated 或只出现 uuid 都不算命中（双关键词缺一不可）', async () => {
    for (const msg of ['Request is repeated without key', 'invalid uuid format']) {
      const f = fakeDwsRepeated(msg);
      const r = await sendReply('cidA', 'msgX', '已开通', { bin: f.bin, uuid: 'k3' });
      expect([msg, r.ok]).toEqual([msg, false]);
      expect(r.duplicated).toBeUndefined();
    }
  });
});
