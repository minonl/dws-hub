/**
 * dws 输出不可解析（exit 0 + 非 JSON）**不得**伪装成「读到了空结果」。
 *
 * 回归用例：真实坑 1 的变体 —— dws 退出码 0，但 stdout 只有进度行
 * `paging 3/20 ...`（JSON 在 stderr 或根本没输出）。
 * 设计：docs/design.md（假成功禁令）
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dwsJson } from './dws.mjs';
import { atMe, chatList, directMessages, mapDwsExit } from './query.mjs';

function fakeDws(script, code = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-dws-noise-'));
  const bin = join(dir, 'dws.sh');
  writeFileSync(bin, `#!/bin/bash\n${script}\nexit ${code}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

const NOISE = fakeDws("echo 'paging 3/20 ...'");
const NOISE_THEN_STDERR_JSON = fakeDws(
  "echo 'paging 3/20 ...'; echo '{\"messages\":[{\"messageId\":\"m1\"}]}' >&2",
);

describe('dwsJson：解析失败不算成功', () => {
  test('exit 0 + 非 JSON 输出 → ok=false, parsed=false, data 只有 _raw', async () => {
    const r = await dwsJson(['chat', '+chat-list'], { bin: NOISE });
    expect(r.ok).toBe(false);
    expect(r.parsed).toBe(false);
    expect(r.code).toBe(0);
    expect(r.data._raw).toContain('paging 3/20');
  });

  test('stdout 噪声 + stderr JSON → 仍能解析成功（坑 1 兜底）', async () => {
    const r = await dwsJson(['chat', '+messages-list-direct'], { bin: NOISE_THEN_STDERR_JSON });
    expect(r.ok).toBe(true);
    expect(r.parsed).toBe(true);
    expect(r.data.messages[0].messageId).toBe('m1');
  });

  test('正常 JSON 输出行为不变', async () => {
    const bin = fakeDws("echo '{\"messages\":[]}'");
    const r = await dwsJson(['chat', '+chat-messages'], { bin });
    expect(r).toMatchObject({ ok: true, parsed: true, code: 0 });
    expect(r.data.messages).toEqual([]);
  });

  test('标量行（如裸数字）不算 JSON 信封 → 仍判解析失败', async () => {
    const bin = fakeDws("echo 'paging 3/20 ...'; echo '3'");
    const r = await dwsJson(['chat', '+chat-list'], { bin });
    expect(r).toMatchObject({ ok: false, parsed: false });
    expect(r.data._raw).toContain('paging 3/20');
  });
});

describe('读类查询：不可解析输出 → 抛上游失败（code 3），不得返回空结果 + complete:true', () => {
  test('chatList', async () => {
    await expect(chatList({ bin: NOISE })).rejects.toMatchObject({ code: 3 });
  });

  test('directMessages', async () => {
    await expect(directMessages({ user: 'u1', since: '2026-11-09T00:00:00Z', bin: NOISE }))
      .rejects.toMatchObject({ code: 3 });
  });

  test('atMe', async () => {
    await expect(atMe({ bin: NOISE })).rejects.toMatchObject({ code: 3 });
  });

  test('mapDwsExit：exit 0 + _raw → hub 3（不是 0）', () => {
    expect(mapDwsExit({ code: 0, data: { _raw: 'paging 3/20 ...' } })).toMatchObject({ code: 3 });
  });
});
