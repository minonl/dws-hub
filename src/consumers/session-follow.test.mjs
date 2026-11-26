/**
 * session-follow 消费者投递单测（用 fake inbox 命令记录环境变量，不碰真实系统）
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { addFollow, emptyFollows, saveFollows } from '../hub/follows.mjs';

const TASK = join(import.meta.dir, 'session-follow.mjs');

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'dws-hub-session-follow-'));
  const follows = join(dir, 'session-follows.json');
  const inbox = join(dir, 'inbox');
  const log = join(dir, 'inbox.log');
  writeFileSync(
    inbox,
    `#!/bin/bash\nprintf '%s|%s|%s\\n' "$DWS_HUB_INBOX_TO" "$DWS_HUB_INBOX_KEY" "$DWS_HUB_INBOX_SUBJECT" >> "$FAKE_INBOX_LOG"\nexit 0\n`,
  );
  chmodSync(inbox, 0o755);
  const doc = emptyFollows();
  addFollow(doc, { session: 'ses_test', scope: 'group:g1', label: '示例群' });
  addFollow(doc, { session: 'ses_atme', scope: 'direct:u1', atmeOnly: true });
  saveFollows(doc, follows);
  return { dir, follows, inbox, log, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function run(env, events) {
  return spawnSync('bun', [TASK], {
    input: JSON.stringify({ consumer: 'session-follow', events }),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

describe('session-follow 消费者', () => {
  test('命中 scope 的事件按命令模板投递（带幂等键），不命中则跳过', () => {
    const t = setup();
    try {
      const r = run(
        {
          DWS_HUB_HOME: t.dir,
          DWS_HUB_FOLLOWS: t.follows,
          DWS_HUB_INBOX_CMD: t.inbox,
          FAKE_INBOX_LOG: t.log,
        },
        [
          { ext_id: 'm1', scope: 'group:g1', sender: 'alice', text: '看下接口', at: '2026-11-13T02:46:00Z' },
          { ext_id: 'm2', scope: 'group:other', sender: 'bob', text: '无关', at: '2026-11-13T02:47:00Z' },
        ],
      );
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, delivered: 1, skipped: 1 });
      const log = readFileSync(t.log, 'utf8');
      expect(log).toContain('ses_test|dws:m1:ses_test|[钉钉] 示例群 · alice');
    } finally {
      t.cleanup();
    }
  });

  test('未配置投递命令：落 logs/inbox-skipped-*.jsonl，不丢消息', () => {
    const t = setup();
    try {
      const r = run(
        { DWS_HUB_HOME: t.dir, DWS_HUB_FOLLOWS: t.follows, DWS_HUB_INBOX_CMD: '' },
        [{ ext_id: 'm9', scope: 'group:g1', sender: 'alice', text: '重要', at: '2026-11-13T02:46:00Z' }],
      );
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.delivered).toBe(0);
      expect(out.note).toContain('DWS_HUB_INBOX_CMD');
      const day = new Date().toISOString().slice(0, 10);
      const skipped = readFileSync(join(t.dir, 'logs', `inbox-skipped-${day}.jsonl`), 'utf8');
      expect(skipped).toContain('dws:m9:ses_test');
    } finally {
      t.cleanup();
    }
  });

  test('自己的消息不再回灌（SELF_OPEN_ID / SELF_NAME）', () => {
    const t = setup();
    try {
      const r = run(
        {
          DWS_HUB_HOME: t.dir,
          DWS_HUB_FOLLOWS: t.follows,
          DWS_HUB_INBOX_CMD: t.inbox,
          FAKE_INBOX_LOG: t.log,
          DWS_HUB_SELF_OPEN_ID: 'SELF_OPEN_ID',
          DWS_HUB_SELF_NAME: 'myself',
        },
        [
          { ext_id: 's1', scope: 'group:g1', sender: 'myself', text: '我自己发的', at: '2026-11-13T02:46:00Z', meta: { senderId: 'SELF_OPEN_ID' } },
        ],
      );
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.delivered).toBe(0);
      expect(out.skipped).toBe(1);
    } finally {
      t.cleanup();
    }
  });

  test('atme_only 只投 @我；aiSendFlag 事件不投', () => {
    const t = setup();
    try {
      const r = run(
        { DWS_HUB_HOME: t.dir, DWS_HUB_FOLLOWS: t.follows, DWS_HUB_INBOX_CMD: t.inbox, FAKE_INBOX_LOG: t.log },
        [
          { ext_id: 'a1', scope: 'direct:u1', sender: 'u1', text: '普通消息', at: '2026-11-13T02:46:00Z' },
          { ext_id: 'a2', scope: 'direct:u1', sender: 'u1', text: '@me 看下', at: '2026-11-13T02:47:00Z', meta: { mentionMe: true } },
          { ext_id: 'a3', scope: 'direct:u1', sender: 'u1', text: '@me 回执', at: '2026-11-13T02:48:00Z', meta: { mentionMe: true, aiSendFlag: '1' } },
        ],
      );
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout).delivered).toBe(1);
      const log = readFileSync(t.log, 'utf8');
      expect(log).toContain('ses_atme');
      expect(log).toContain('dws:a2:ses_atme');
      expect(log).not.toContain('dws:a1:ses_atme');
      expect(log).not.toContain('dws:a3:ses_atme');
    } finally {
      t.cleanup();
    }
  });
});
