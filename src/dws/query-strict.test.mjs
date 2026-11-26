/** 严格 JSON：日志/NDJSON 混排不得当成功（docs/design.md #2） */
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { atMe } from './query.mjs';

function fakeDws(stdout, code = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-dws-strict-'));
  const bin = join(dir, 'dws.sh');
  writeFileSync(bin, `#!/bin/bash\ncat <<'EOF'\n${stdout}\nEOF\nexit ${code}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

describe('严格 JSON', () => {
  test('日志行 + JSON 混排 → 失败（不当空结果）', async () => {
    const bin = fakeDws('paging 1/20 ...\n{"messages":[]}');
    await expect(atMe({ bin })).rejects.toMatchObject({ code: 3 });
  });

  test('纯 JSON 但带 error 信封 → 失败', async () => {
    const bin = fakeDws('{"ok":false,"error":{"category":"api","message":"rate_limited"},"messages":[]}');
    await expect(atMe({ bin })).rejects.toMatchObject({ code: 3 });
  });

  test('纯 JSON 正常 → 成功', async () => {
    const bin = fakeDws('{"messages":[{"messageId":"m1"}],"complete":true}');
    const r = await atMe({ bin });
    expect(r.messages[0].messageId).toBe('m1');
  });
});

describe('atMe 参数边界（hub 契约：参数错误 = code 2，不触上游）', () => {
  test('days 越界（0 / 31 / 小数）→ code 2', async () => {
    const bin = fakeDws('{"messages":[]}');
    for (const days of [0, -1, 31, 1.5, '7']) {
      await expect(atMe({ days, bin })).rejects.toMatchObject({ code: 2, retryable: false });
    }
  });

  test('days 边界值 1 / 30 合法（会真正调 dws，用正常信封兜住）', async () => {
    const bin = fakeDws('{"messages":[],"complete":true}');
    await expect(atMe({ days: 1, bin })).resolves.toMatchObject({ complete: true });
    await expect(atMe({ days: 30, bin })).resolves.toMatchObject({ complete: true });
  });

  test('chatId 与 senders 互斥 → code 2（不猜优先级）', async () => {
    const bin = fakeDws('{"messages":[]}');
    await expect(atMe({ chatId: 'cid1', senders: ['u1'], bin }))
      .rejects.toMatchObject({ code: 2, retryable: false });
  });

  test('只给 chatId 或只给 senders → 合法', async () => {
    const bin = fakeDws('{"messages":[],"complete":true}');
    await expect(atMe({ chatId: 'cid1', bin })).resolves.toMatchObject({ complete: true });
    await expect(atMe({ senders: ['u1'], bin })).resolves.toMatchObject({ complete: true });
  });
});
