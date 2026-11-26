/**
 * 分层纪律机检（docs/design.md 硬约束）
 *
 * `hub/` 是**渠道无关核心** —— 不得出现渠道字样；渠道细节必须全部收敛在 `../dws/`。
 * 这条纪律就是「轻抽象」的全部成本，所以**用测试钉住**，而不是靠自觉。
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const FORBIDDEN = ['dws', 'dingtalk', 'ding', 'message_id', 'messageId', 'conversation_id', 'openConversationId', 'openDingTalkId', 'chat-messages'];

describe('分层纪律：hub/ 渠道无关', () => {
  const files = readdirSync(here).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'));

  test('hub/ 下有核心文件（防误删/改名导致检查空转）', () => {
    expect(files.length).toBeGreaterThanOrEqual(4);
  });

  for (const f of files) {
    test(`hub/${f} 不含渠道字样`, () => {
      const src = readFileSync(join(here, f), 'utf8');
      const code = src.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*')).join('\n');
      const hits = FORBIDDEN.filter((w) => new RegExp(`\\b${w}\\b`).test(code));
      expect(hits).toEqual([]);
    });
  }
});
