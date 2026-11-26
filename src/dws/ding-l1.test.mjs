/**
 * L1 `sendPersonalDing` 成功判定（不联网：假 dws）
 * 设计：docs/design.md（redteam high #1）
 *
 * ⚠️ 回归点：旧实现 `ok = r.ok || /"success":true/.test(raw)` ——
 *    dws 失败时 raw 里回显的请求体/错误信封可能含 `"success":true`
 *    ⇒ 把「实际失败」翻成 ok:true ⇒ 调用方以为已送达、不重发 = 静默假绿。
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sendPersonalDing } from './ding.mjs';

function fakeDws(stdout, code = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-dws-l1-'));
  const bin = join(dir, 'dws.sh');
  writeFileSync(bin, `#!/bin/bash\ncat <<'EOF'\n${stdout}\nEOF\nexit ${code}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

describe('sendPersonalDing / 成功判定只看退出码', () => {
  test('exit 0 + ok:true → ok', async () => {
    const bin = fakeDws(JSON.stringify({ ok: true, openDingId: 'd1' }), 0);
    const r = await sendPersonalDing({ openDingTalkId: 'o1', text: 'x', bin });
    expect(r.ok).toBe(true);
  });

  test('exit 非 0 + raw 含 "success":true → **必须 ok:false**（旧实现在这里假绿）', async () => {
    const bin = fakeDws(JSON.stringify({ error: { message: 'partial: {"success":true} in echo' } }), 1);
    const r = await sendPersonalDing({ openDingTalkId: 'o1', text: 'x', bin });
    expect(r.ok).toBe(false);
  });

  test('exit 非 0 + {"ok":false} → ok:false', async () => {
    const bin = fakeDws(JSON.stringify({ ok: false }), 1);
    const r = await sendPersonalDing({ openDingTalkId: 'o1', text: 'x', bin });
    expect(r.ok).toBe(false);
  });

  test('dryRun：不发请求、返回 argv（零出网）', async () => {
    const bin = fakeDws('{}', 1);   // 若真被调用会 exit 1 → 失败
    const r = await sendPersonalDing({ openDingTalkId: 'o1', text: 'x', bin, dryRun: true });
    expect(r.ok).toBe(true);
    expect(r.dry_run).toBe(true);
    expect(Array.isArray(r.argv)).toBe(true);
  });
});
