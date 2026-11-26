/** dws 适配层单测：scope 编译 / 消息归一 / 时间归一 / 出站标记（不发网络请求） */
import { describe, expect, test } from 'bun:test';
import { extractReactionEvents, normalizeMessage, pollScope, reactionIntent, scopeSpec, streamArgsFor, toIso } from './listen.mjs';
import { isMachineText, isOutboundText, outboundMarker } from './dws.mjs';

describe('listen / scope 与 stream 参数', () => {
  test('scope → dws 目标参数', () => {
    expect(scopeSpec('self')).toEqual({ kind: 'self' });
    expect(scopeSpec('group:cidABC')).toEqual({ kind: 'group', id: 'cidABC', args: ['--group', 'cidABC'] });
    expect(scopeSpec('direct:uid_demo_0001')).toEqual({ kind: 'direct', id: 'uid_demo_0001', args: ['--user', 'uid_demo_0001'] });
  });

  test('direct 的 openId 形态走 --open-dingtalk-id，userId 走 --user', () => {
    expect(scopeSpec('direct:u123456').args).toEqual(['--user', 'u123456']);
    expect(scopeSpec('direct:ExampleOpenId0123456789ABCDEF').args).toEqual([
      '--open-dingtalk-id',
      'ExampleOpenId0123456789ABCDEF',
    ]);
    expect(streamArgsFor('direct:ExampleOpenId0123456789ABCDEF')).toContain('--open-dingtalk-id');
  });

  test('self 无事件通道（自聊消息被 self-loop 过滤）→ 只能轮询', () => {
    expect(streamArgsFor('self')).toBeNull();
    // ⚠️ 稳定 ID（cid…）必须走 `--chat-id`；只有**群名**才用 `--chat-query`（否则流起来就退，2026-10-16 实测）
    expect(streamArgsFor('group:cidABC==')).toEqual(['event', '+listen-im', '--kind', 'group', '--chat-id', 'cidABC==']);
    expect(streamArgsFor('group:示例客户群')).toEqual(['event', '+listen-im', '--kind', 'group', '--chat-query', '示例客户群']);
    expect(streamArgsFor('direct:u1')).toEqual(['event', '+listen-im', '--kind', 'sender', '--user', 'u1']);
  });

  test('自聊轮询缺 userId 时明确报错（不静默空跑）', async () => {
    const r = await pollScope({ scope: 'self', sinceIso: '2026-10-16T00:00:00.000Z', endIso: '2026-10-16T01:00:00.000Z' });
    expect(r.error).toBe('missing_self_user');
    expect(r.events).toEqual([]);
  });
});

describe('listen / 消息归一', () => {
  test('引用回复 → reply_to（锚点匹配键）；出站标记 → outbound', () => {
    const e = normalizeMessage({
      messageId: 'm1', sender: '王示例', text: '这个先别开',
      createTime: '2026-10-16 14:00:00',
      quotedMessage: { messageId: 'anchor-msg-1', text: '🤖 dws-hub · ledger 有 3 个 org 异常' },
    }, { scope: 'self', source: 'self' });
    expect(e.ext_id).toBe('m1');
    expect(e.reply_to).toBe('anchor-msg-1');
    expect(e.scope).toBe('self');
    expect(e.source).toBe('self');
    expect(e.outbound).toBe(false);                             // 人写的 → 入站
    expect(e.at).toBe('2026-10-16T06:00:00.000Z');              // +08:00 语义
  });

  test('本能力自己发出的消息被标记 → outbound（防自我回环，docs/design.md）', () => {
    const text = `${outboundMarker('ledger')}\n摘要：3 条新反馈`;
    const e = normalizeMessage({ messageId: 'm2', text, createTime: Date.now() }, { scope: 'self', source: 'self' });
    expect(e.outbound).toBe(true);
    expect(isOutboundText(text)).toBe(true);
    expect(isOutboundText('我自己的话')).toBe(false);
  });

  test('机器消息：只认本包标记，其它服务文案由调用方追加', () => {
    // 本包标记 → 机器
    expect(isMachineText('🤖 dws-hub · cron')).toBe(true);
    // 别家服务文案：默认不算，必须由调用方显式追加（本包不硬编码任何公司文案）
    expect(isMachineText('【新服务】通知')).toBe(false);
    expect(isMachineText('【新服务】通知', { extra: ['【新服务】'] })).toBe(true);
    // 真人的话 → 不是机器
    expect(isMachineText('我觉得这个先别开，我问问产品')).toBe(false);
  });
});

describe('listen / 表情回应作为输入路径（docs/design.md 路径②）', () => {
  const msg = {
    messageId: 'msgA', conversationId: 'cidX', createTime: '2026-10-16 15:35:15',
    text: '🤖 dws-hub · e2e 请引用本条回复',
    reactions: { counts: [{ count: 1, emoji: 'OK' }], details: [{ emoji: 'OK', replyUsers: ['王示例'] }] },
  };

  test('人的表情回应 → 合成入站事件（reply_to 指向被回应消息，复用锚点匹配）', () => {
    const evs = extractReactionEvents(msg, { scope: 'self' });
    expect(evs.length).toBe(1);
    expect(evs[0].ext_id).toBe('msgA#rx:OK:王示例');            // 稳定合成 id（天然去重）
    expect(evs[0].reply_to).toBe('msgA');
    expect(evs[0].outbound).toBe(false);                      // 是**人的输入**
    expect(evs[0].meta.conversation_id).toBe('cidX');
    expect(evs[0].meta.reaction).toBe('OK');
    expect(evs[0].meta.intent).toBe('ack');
    expect(evs[0].text).toBe('[表情] OK');
  });

  test('**我们自己贴的状态表情要跳过**（否则自我回环）', () => {
    const ours = { ...msg, reactions: { details: [{ emoji: '收到', replyUsers: ['王示例'] }, { emoji: '思考', replyUsers: ['王示例'] }, { emoji: '撒花', replyUsers: ['王示例'] }] } };
    expect(extractReactionEvents(ours, { scope: 'self' })).toEqual([]);
  });

  test('意图映射：ack / approve / reject / other', () => {
    expect(reactionIntent('OK')).toBe('ack');
    expect(reactionIntent('点赞')).toBe('ack');
    expect(reactionIntent('Done')).toBe('approve');
    expect(reactionIntent('打叉')).toBe('reject');
    expect(reactionIntent('随机表情')).toBe('other');
  });

  test('无 reactions 字段 → 不产出（老消息兼容）', () => {
    expect(extractReactionEvents({ messageId: 'm', createTime: '2026-10-16 15:00:00' }, { scope: 'self' })).toEqual([]);
  });
});

describe('listen / 时间归一', () => {
  test('毫秒数 / 秒数 / 字符串（+08:00）/ ISO', () => {
    expect(toIso(1792132800000)).toBe(new Date(1792132800000).toISOString());
    expect(toIso('2026-10-16 14:00:00')).toBe('2026-10-16T06:00:00.000Z');
    expect(toIso('2026-10-16T06:00:00.000Z')).toBe('2026-10-16T06:00:00.000Z');
    expect(toIso('2026-10-16')).toMatch(/^2026-10-1[56]T/);      // 宽松兜底不抛错
  });
});

describe('listen / 轮询重试（坏 IP 自签证书抖动，2026-10-21 实证）', () => {
  const { mkdtempSync, writeFileSync, chmodSync, rmSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'dws-poll-retry-'));

  /** 假 dws：前 failTimes 次报 TLS 错误，之后返回一条消息 */
  function flakyBin(failTimes) {
    const counter = join(dir, `n-${Math.random().toString(36).slice(2)}`);
    const bin = join(dir, `dws-${Math.random().toString(36).slice(2)}.sh`);
    writeFileSync(bin, `#!/bin/bash
CTR="${counter}"
n=$(cat "$CTR" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$CTR"
if [ "$n" -le ${failTimes} ]; then
  echo '{"ok":false,"error":{"type":"tls","message":"x509: certificate signed by unknown authority"}}' >&2
  exit 1
fi
echo '{"complete":true,"messages":[{"messageId":"m-retry-1","sender":"alice","text":"00000000-0000-0000-0000-000000456275","createTime":"2026-10-21 10:00:00"}]}'
`);
    chmodSync(bin, 0o755);
    return { bin, counter };
  }

  test('前 2 次 TLS 失败 → 第 3 次成功（complete=true）', async () => {
    const { bin, counter } = flakyBin(2);
    const r = await pollScope({
      scope: 'group:cidTEST', sinceIso: '2026-10-21T00:00:00.000Z', endIso: '2026-10-21T02:00:00.000Z',
      bin, attempts: 3, retryDelayMs: 0,
    });
    expect(r.complete).toBe(true);
    expect(r.events.length).toBe(1);
    expect(r.events[0].ext_id).toBe('m-retry-1');
    expect(require('node:fs').readFileSync(counter, 'utf-8').trim()).toBe('3');
  });

  test('一直失败 → 有界（attempts 次）后返回最后错误，不无限重试', async () => {
    const { bin, counter } = flakyBin(99);
    const r = await pollScope({
      scope: 'group:cidTEST', sinceIso: '2026-10-21T00:00:00.000Z', endIso: '2026-10-21T02:00:00.000Z',
      bin, attempts: 3, retryDelayMs: 0,
    });
    expect(r.complete).toBe(false);
    expect(r.error).toContain('certificate signed by unknown authority');
    expect(require('node:fs').readFileSync(counter, 'utf-8').trim()).toBe('3');
  });

  test('attempts=1 → 不重试（逃生舱）', async () => {
    const { bin, counter } = flakyBin(1);
    const r = await pollScope({
      scope: 'group:cidTEST', sinceIso: '2026-10-21T00:00:00.000Z', endIso: '2026-10-21T02:00:00.000Z',
      bin, attempts: 1, retryDelayMs: 0,
    });
    expect(r.complete).toBe(false);
    expect(require('node:fs').readFileSync(counter, 'utf-8').trim()).toBe('1');
  });

  test('确定性错误（bad_scope）**不重试**', async () => {
    const r = await pollScope({ scope: 'unknown:xx', sinceIso: '2026-10-21T00:00:00.000Z', endIso: '2026-10-21T02:00:00.000Z' });
    expect(r).toEqual({ events: [], complete: false, error: 'bad_scope' });
  });

  // 清理
  test('cleanup', () => { rmSync(dir, { recursive: true, force: true }); expect(true).toBe(true); });
});
