/**
 * dws 适配层单测：通知阶梯（DING→待办→日历→消息）/ 限频联动 / 锚点联动 / 引用回复
 * 全部在 **dry-run**（未设 DWS_HUB_ENABLE）下运行 —— 不发任何真实消息。
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../hub/store.mjs';
import { recordReply } from '../hub/anchors.mjs';
import { notify, readbackMessageId, replyInChain, replyTarget, sendDing } from './notify.mjs';
import { REAL } from './dws.mjs';

const T1400 = Date.parse('2026-10-16T06:00:00.000Z');   // 北京 14:00（非静默）

describe('notify / 安全默认', () => {
  test('未开 DWS_HUB_ENABLE → dry-run', () => {
    expect(REAL).toBe(false);
  });
});

describe('notify / 消息 id 回读（关键集成点）', () => {
  const TMP = join(tmpdir(), `dws-hub-notify-test-${process.pid}`);
  mkdirSync(TMP, { recursive: true });
  afterAll(() => rmSync(TMP, { recursive: true, force: true }));
  /** 造一个假 dws：按 args 输出预设 JSON（放在受管临时目录，收尾统一清理） */
  function fakeDws(body) {
    const p = join(TMP, `fake-dws-${Math.random().toString(36).slice(2)}.sh`);
    const { writeFileSync, chmodSync } = require('node:fs');
    writeFileSync(p, `#!/bin/bash\ncat <<'EOF'\n${body}\nEOF\n`);
    chmodSync(p, 0o755);
    return p;
  }

  test('回读到真实 messageId（`+dm` 的 openTaskId 不是消息 id）', async () => {
    const bin = fakeDws(JSON.stringify({ messages: [{ messageId: 'msgREAL123', text: '🤖 dws-hub · x 有 3 个 org 异常 事项：anchor-2026-10-16-001' }] }));
    const mid = await readbackMessageId({ selfUser: 'u1', matchText: 'anchor-2026-10-16-001', bin, attempts: 1, delayMs: 5 });
    expect(mid).toBe('msgREAL123');
  });

  test('回读不到（消息还没落库/正文不匹配）→ null，调用方须据此标记「锚点仅能靠事项号兜底」', async () => {
    const bin = fakeDws(JSON.stringify({ messages: [{ messageId: 'msgOther', text: '别的消息' }] }));
    const mid = await readbackMessageId({ selfUser: 'u1', matchText: 'anchor-2026-10-16-001', bin, attempts: 1, delayMs: 5 });
    expect(mid).toBeNull();
  });
});

describe('notify / 阶梯', () => {
  test('info 档：走自聊消息', async () => {
    const s = openStore(':memory:');
    const r = await notify(s, { consumer: 'ledger', title: '摘要', text: '3 条新反馈', now: T1400 });
    expect(r.ok).toBe(true);
    expect(r.endpoint).toBe('message');
    expect(r.effective_strength).toBe('info');
    expect(r.downgraded).toBe(false);
    expect(r.anchor).toBeNull();                                  // 不需要决策 → 不建锚点
  });

  test('strong 档：DING 不可用（缺 openId）→ 自动降级到待办，并如实回报', async () => {
    const s = openStore(':memory:');
    const r = await notify(s, { consumer: 'ledger', title: '需立刻注意', strength: 'strong', now: T1400 });
    expect(r.attempts[0]).toEqual({ endpoint: 'ding', ok: false, error: 'missing_self_open_id', dry_run: undefined });
    expect(r.endpoint).toBe('todo');
    expect(r.downgraded).toBe(true);
    expect(r.effective_strength).toBe('info');                    // 没到 DING 强度 → 如实降级
  });

  test('strong + 静默时段：DING 被闸 → 降级待办（自聊消息不受静默限制）', async () => {
    const s = openStore(':memory:');
    const quiet = Date.parse('2026-10-16T14:00:00.000Z');         // 北京 22:00
    const r = await notify(s, { consumer: 'x', title: 't', strength: 'strong', now: quiet, force: true });
    // force 越过静默 → 但 DING 仍因缺 openId 不可用 → 落到待办
    expect(r.endpoint).toBe('todo');
  });

  test('needs-decision：**通知正文里带事项号**（引用失效时还能靠事项号兜底）+ 建锚点', async () => {
    const s = openStore(':memory:');
    const r = await notify(s, { consumer: 'ledger', title: '请决策', text: '是否开通', needsDecision: true, now: T1400 });
    expect(r.anchor).not.toBeNull();
    expect(r.anchor.status).toBe('open');
    expect(r.anchor.needs_decision).toBe(true);
    expect(r.anchor.ext_id.startsWith('dry:')).toBe(true);
    expect(r.anchor.id).toMatch(/^anchor-\d{4}-\d{2}-\d{2}-\d{3}$/);
    // 正文必须含：出站标记 + 事项号 + 引用引导（缺一 → 人工无法引用/兜底识别失效）
    expect(r.body).toContain('🤖 dws-hub');
    expect(r.body).toContain(r.anchor.id);
    expect(r.body).toContain('引用本条回复');
    expect(s.anchors.byId(r.anchor.id).consumer).toBe('ledger');
  });
});

describe('notify / 待办降级链', () => {
  test('sendDing 缺 openId 时明确失败（不静默假成功）', async () => {
    const r = await sendDing({ text: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('missing_self_open_id');
  });

  test('待办额度（5/日）耗尽后继续降级到日历', async () => {
    const s = openStore(':memory:');
    // 先把 todo 额度用满（模拟当天已降级 5 次）
    for (let i = 0; i < 5; i++) s.kv.bump('ratelimit:todo', new Date(T1400 + 8 * 3600e3).toISOString().slice(0, 10), 1);
    const r = await notify(s, { consumer: 'x', title: 't', strength: 'strong', now: T1400 });
    expect(r.attempts.some((x) => x.endpoint === 'todo' && x.skipped === 'per_day')).toBe(true);
    expect(r.endpoint).toBe('calendar');                          // 继续降级
    expect(r.downgraded).toBe(true);
  });
});

describe('notify / 引用目标选择（replyTarget）', () => {
  test('普通文本回复 → 挂在最近一条入站回复下（就近成链）', () => {
    const anchor = { ext_id: 'msg-anchor', replies: [{ direction: 'in', extId: 'msg-human-reply' }] };
    expect(replyTarget(anchor)).toBe('msg-human-reply');
  });

  test('**表情回应输入（合成 id）不能当引用目标** → 退回锚点消息', () => {
    const anchor = { ext_id: 'msg-anchor', replies: [{ direction: 'in', extId: 'msg-anchor#rx:OK:王示例' }] };
    expect(replyTarget(anchor)).toBe('msg-anchor');
  });

  test('显式 refExtId 优先；无入站回复 → 锚点消息', () => {
    expect(replyTarget({ ext_id: 'a', replies: [] }, 'msg-x')).toBe('msg-x');
    expect(replyTarget({ ext_id: 'a', replies: [] })).toBe('a');
  });
});

describe('notify / 引用回复', () => {
  test('replyInChain：记录出站往来 + 推进状态 acting', async () => {
    const s = openStore(':memory:');
    const { anchor } = await notify(s, { consumer: 'ledger', title: '请决策', needsDecision: true, now: T1400 });
    const r = await replyInChain(s, { anchorId: anchor.id, refExtId: anchor.ext_id, text: '已跳过该 org' });
    expect(r.ok).toBe(true);
    const after = s.anchors.byId(anchor.id);
    expect(after.status).toBe('acting');
    expect(after.replies.at(-1).direction).toBe('out');
    expect(after.replies.at(-1).text).toContain('已跳过该 org');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2026-11-09：DING 台账（`hub_ding_log`）—— 每次 notify **一行**
//   设计：docs/design.md
// ═══════════════════════════════════════════════════════════════════
describe('notify / 台账（hub_ding_log）', () => {
  test('info：成功路径也落一行（endpoint=message，gate=null）', async () => {
    const s = openStore(':memory:');
    await notify(s, { consumer: 'ledger', title: '摘要', text: '3 条', now: T1400 });
    const rows = s.dingLog.list({ since: new Date(T1400 - 60e3).toISOString() });
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      consumer: 'ledger', requested_strength: 'info', endpoint: 'message',
      ok: true, downgraded: false, gate: null, anchor_id: null,
    });
    expect(rows[0].ts).toBe(new Date(T1400).toISOString());
    expect(rows[0].id.startsWith('ding-')).toBe(true);
  });

  test('strong 降级：如实记 downgraded + gate + 未走 DING 的原因（error）', async () => {
    const s = openStore(':memory:');
    const r = await notify(s, { consumer: 'ledger', title: '需立刻注意', strength: 'strong', now: T1400 });
    expect(r.endpoint).toBe('todo');
    const [row] = s.dingLog.list({ since: new Date(T1400 - 60e3).toISOString() });
    expect(row.endpoint).toBe('todo');
    expect(row.requested_strength).toBe('strong');
    expect(row.ok).toBe(true);
    expect(row.downgraded).toBe(true);
    expect(row.gate).toBe('ok');                                  // 闸允许，但通道本身不可用
    expect(row.error).toBe('missing_self_open_id');
  });

  test('gate 记录限频原因（per_day）', async () => {
    const s = openStore(':memory:');
    const day = new Date(T1400 + 8 * 3600e3).toISOString().slice(0, 10);
    for (let i = 0; i < 2; i++) s.kv.bump('ratelimit:strong_push', day, 1);   // 2/日 用满
    await notify(s, { consumer: 'x', title: 't', strength: 'strong', now: T1400 });
    const [row] = s.dingLog.list({ since: new Date(T1400 - 60e3).toISOString() });
    expect(row.gate).toBe('per_day');
    expect(row.downgraded).toBe(true);
  });

  test('needsDecision：台账记下锚点号（可反查）', async () => {
    const s = openStore(':memory:');
    const r = await notify(s, { consumer: 'ledger', title: '请决策', needsDecision: true, now: T1400 });
    const [row] = s.dingLog.list({ since: new Date(T1400 - 60e3).toISOString() });
    expect(row.anchor_id).toBe(r.anchor.id);
  });

  test('title 截断 200 字', async () => {
    const s = openStore(':memory:');
    await notify(s, { consumer: 'x', title: 'T'.repeat(400), now: T1400 });
    const [row] = s.dingLog.list({ since: new Date(T1400 - 60e3).toISOString() });
    expect(row.title.length).toBe(200);
  });

  test('台账写入失败**不影响**发送返回值，只 warn', async () => {
    const s = openStore(':memory:');
    s.dingLog.insert = () => { throw new Error('db is down'); };
    const warns = [];
    const prev = console.warn;
    console.warn = (...a) => warns.push(a.join(' '));
    try {
      const r = await notify(s, { consumer: 'x', title: 't', strength: 'strong', now: T1400 });
      expect(r.ok).toBe(true);
      expect(r.endpoint).toBe('todo');
    } finally {
      console.warn = prev;
    }
    expect(warns.some((w) => w.includes('台账写入失败'))).toBe(true);
  });

  test('list：since 窗口 / consumer 过滤 / limit', () => {
    const s = openStore(':memory:');
    const base = Date.now();
    s.dingLog.insert({ ts: new Date(base - 48 * 3600e3).toISOString(), consumer: 'a', endpoint: 'message', ok: true, title: 'old' });
    for (let i = 0; i < 3; i += 1) {
      s.dingLog.insert({ ts: new Date(base - i * 1000).toISOString(), consumer: 'a', endpoint: 'message', ok: true, title: `n${i}` });
    }
    s.dingLog.insert({ ts: new Date(base + 5e3).toISOString(), consumer: 'b', endpoint: 'ding', ok: true, title: 'b' });

    expect(s.dingLog.list({}).length).toBe(4);                                    // 默认 24h（a 的 3 条 + b 1 条；48h 前那条排除）
    expect(s.dingLog.list({ since: new Date(base - 24 * 3600e3).toISOString() }).length).toBe(4);
    expect(s.dingLog.list({ since: new Date(base - 24 * 3600e3).toISOString(), consumer: 'a' }).length).toBe(3);
    expect(s.dingLog.list({ since: new Date(base - 24 * 3600e3).toISOString(), limit: 2 }).length).toBe(2);
    expect(s.dingLog.list({ since: new Date(base - 60 * 3600e3).toISOString() })[0].consumer).toBe('b');  // 倒序：最新在前
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2026-11-09：强通知凭据传递 —— 调用方只设 `ANCHOR_SELF_OPEN_ID`（服务契约）
//   ⚠️ hub 只读 `DWS_HUB_SELF_OPEN_ID`；通道必须把 openId **传进来**，
//      否则 strong 会被静默降级成待办，真实 DING 永远发不出。
// ═══════════════════════════════════════════════════════════════════
describe('notify / 强通知凭据（openId）传递', () => {
  const TMP = join(tmpdir(), `dws-hub-notify-openid-${process.pid}`);
  mkdirSync(TMP, { recursive: true });
  afterAll(() => rmSync(TMP, { recursive: true, force: true }));

  // env 隔离：三个开关用例间必须**显式恢复**（bun test 共享 process.env；
  // DWS_HUB_ENABLE=1 泄漏会让后续用例真发 dws 请求）
  const ENV_KEYS = ['DWS_HUB_ENABLE', 'DWS_HUB_SELF_OPEN_ID', 'ANCHOR_SELF_OPEN_ID'];
  let savedEnv;
  beforeEach(() => { savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]])); });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  /** 假 dws：记录参数，按子命令回 DING / 待办的成功 JSON */
  function fakeOpenIdDws(logPath) {
    const p = join(TMP, `fake-dws-openid-${Math.random().toString(36).slice(2)}.sh`);
    writeFileSync(p, [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}`,
      'case "$1 $2" in',
      '  "ding +send-personal") echo \'{"ok":true,"openDingId":"oid-1"}\' ;;',
      '  "todo +remind") echo \'{"ok":true,"taskId":"task-1"}\' ;;',
      '  *) echo \'{"ok":true}\' ;;',
      'esac',
    ].join('\n'));
    chmodSync(p, 0o755);
    return p;
  }

  /** 假 dws：DING 失败（用于验证 openId 不污染待办/日历参数） */
  function fakeDingFailDws(logPath) {
    const p = join(TMP, `fake-dws-dingfail-${Math.random().toString(36).slice(2)}.sh`);
    writeFileSync(p, [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}`,
      'case "$1 $2" in',
      '  "ding +send-personal") echo \'{"ok":false,"error":"boom"}\'; exit 1 ;;',
      '  "todo +remind") echo \'{"ok":true,"data":{"taskId":"task-1"}}\' ;;',
      '  *) echo \'{"ok":true}\' ;;',
      'esac',
    ].join('\n'));
    chmodSync(p, 0o755);
    return p;
  }

  test('显式 openId → 真发 DING（不因缺 DWS_HUB_SELF_OPEN_ID 静默降级待办）', async () => {
    const s = openStore(':memory:');
    const log = join(TMP, `calls-${Math.random().toString(36).slice(2)}.log`);
    const bin = fakeOpenIdDws(log);

    process.env.DWS_HUB_ENABLE = '1';
    process.env.ANCHOR_SELF_OPEN_ID = 'anchor-oid-123';
    delete process.env.DWS_HUB_SELF_OPEN_ID;
    const r = await notify(s, {
      consumer: 'anchor-channel', title: '磁盘快满了', strength: 'strong',
      openId: 'anchor-oid-123', now: T1400, bin,
    });
    expect(r.ok).toBe(true);
    expect(r.endpoint).toBe('ding');                      // 真发 DING，不是降级待办
    expect(r.downgraded).toBe(false);
    expect(r.effective_strength).toBe('strong');
    const calls = readFileSync(log, 'utf8');
    expect(calls).toContain('ding +send-personal --users anchor-oid-123');   // 用的是传入的 openId
    expect(calls).not.toContain('todo +remind');          // 没有静默降级
  });

  test('openId 缺省（hub 自身 env 也未设）→ 如实降级：downgraded=true 且 endpoint!==ding', async () => {
    delete process.env.DWS_HUB_ENABLE;                    // 干跑：绝不真发
    delete process.env.DWS_HUB_SELF_OPEN_ID;
    delete process.env.ANCHOR_SELF_OPEN_ID;
    const s = openStore(':memory:');
    const r = await notify(s, { consumer: 'x', title: 't', strength: 'strong', now: T1400 });
    expect(r.endpoint).not.toBe('ding');
    expect(r.downgraded).toBe(true);
    expect(r.attempts[0]).toMatchObject({ endpoint: 'ding', ok: false, error: 'missing_self_open_id' });
  });

  test('openId 只作用于 ding 级：DING 失败降级待办时，待办 argv 不含 openId', async () => {
    const s = openStore(':memory:');
    const log = join(TMP, `calls-fail-${Math.random().toString(36).slice(2)}.log`);
    const bin = fakeDingFailDws(log);

    process.env.DWS_HUB_ENABLE = '1';
    delete process.env.DWS_HUB_SELF_OPEN_ID;
    const r = await notify(s, {
      consumer: 'x', title: 't', strength: 'strong',
      openId: 'anchor-oid-123', now: T1400, bin,
    });
    expect(r.endpoint).toBe('todo');
    expect(r.downgraded).toBe(true);
    const todoLines = readFileSync(log, 'utf8').trim().split('\n').filter((l) => l.startsWith('todo '));
    expect(todoLines.length).toBeGreaterThan(0);
    // 凭据不泄漏到降级通道：待办命令参数里不应出现 openId
    expect(todoLines.every((l) => !l.includes('anchor-oid-123'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2026-11-09：`--ref-msg-id` / `--conversation-id`（告警引到触发消息下）
//   用户原话：「一些 DING 通知已读以后就找不到了，确实没有和会话里的消息关联住」
// ═══════════════════════════════════════════════════════════════════
describe('notify / 引用触发消息（ref-msg-id）', () => {
  test('带 ref + conversation：走 reply，endpoint=reply（干跑不发真实请求）', async () => {
    const s = openStore(':memory:');
    const r = await notify(s, {
      consumer: 'example-job', title: '示例告警', text: 'org X',
      refMsgId: 'msgTRIGGER', conversationId: 'cidTRIGGER', now: T1400,
    });
    expect(r.ok).toBe(true);
    expect(r.endpoint).toBe('reply');
    expect(r.dry_run).toBe(true);
    expect(r.attempts[0].endpoint).toBe('reply');
  });

  test('带 ref + needsDecision：锚点 scope=conversation 且记录 sent_to 会话', async () => {
    const s = openStore(':memory:');
    const r = await notify(s, {
      consumer: 'example-job', title: '请处理', needsDecision: true,
      refMsgId: 'msgTRIGGER', conversationId: 'cidTRIGGER', now: T1400,
    });
    expect(r.anchor).not.toBeNull();
    expect(r.anchor.scope).toBe('conversation');
    expect(r.anchor.context.sent_to).toBe('cidTRIGGER');
    expect(r.anchor.conversation_id).toBe('cidTRIGGER');
  });

  test('reply 失败 → 降级到原阶梯（info=自聊消息），并如实回报 attempts', async () => {
    const s = openStore(':memory:');
    const r = await notify(s, {
      consumer: 'example-job', title: '示例告警',
      refMsgId: 'msgTRIGGER', conversationId: 'cidTRIGGER', now: T1400,
      replyImpl: async () => ({ ok: false, error: 'reply_failed' }),
    });
    expect(r.endpoint).toBe('message');
    expect(r.attempts.some((a) => a.endpoint === 'reply' && a.ok === false)).toBe(true);
  });

  test('只给 ref 不给 conversation → 不尝试 reply（避免发错会话），走原阶梯', async () => {
    const s = openStore(':memory:');
    const r = await notify(s, { consumer: 'x', title: 't', refMsgId: 'msgTRIGGER', now: T1400 });
    expect(r.endpoint).toBe('message');
    expect(r.attempts.some((a) => a.endpoint === 'reply')).toBe(false);
  });

  test('不带 ref → 行为完全不变（向后兼容）', async () => {
    const s = openStore(':memory:');
    const r = await notify(s, { consumer: 'x', title: 't', now: T1400 });
    expect(r.endpoint).toBe('message');
    expect(r.attempts.every((a) => a.endpoint !== 'reply')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 锚点会话字段：reply 成功 → 锚点记住「会话」，后续追问/结论能回到同一条链
//   （否则 replyInChain 拿不到会话 id → 引用回复发不出去）
// ═══════════════════════════════════════════════════════════════════
describe('notify / 锚点会话可读字段 + 会话内追问', () => {
  const TMP = join(tmpdir(), `dws-hub-notify-scope-${process.pid}`);
  mkdirSync(TMP, { recursive: true });
  afterAll(() => rmSync(TMP, { recursive: true, force: true }));

  /** 假 dws：记录调用参数，回一条 messageId（让 replyInChain 走真实发送路径） */
  function fakeReplyDws(logPath) {
    const p = join(TMP, `fake-dws-reply-${Math.random().toString(36).slice(2)}.sh`);
    writeFileSync(p, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(logPath)}\necho '{"ok":true,"data":{"messageId":"sent-reply-1"}}'\n`);
    chmodSync(p, 0o755);
    return p;
  }

  test('context 落库/读回都是对象；会话 id 有独立可读字段；replyInChain 回到该会话', async () => {
    const s = openStore(':memory:');
    const r = await notify(s, {
      consumer: 'example-job', title: '请处理', needsDecision: true,
      refMsgId: 'msgTRIGGER', conversationId: 'cidTRIGGER', now: T1400,
      replyImpl: async () => ({ ok: true, ext_id: 'msgNOTIFY1' }),
    });

    // ① context = 对象（不是 JSON 字符串）
    const anchor = r.anchor;
    expect(anchor).not.toBeNull();
    expect(typeof anchor.context).toBe('object');
    expect(anchor.context).toEqual({ sent_to: 'cidTRIGGER', ref_msg_id: 'msgTRIGGER' });
    // ② 会话 id 有可读字段（dws 侧别名 + hub 侧持久化字段）
    expect(anchor.conversation_id).toBe('cidTRIGGER');
    const persisted = s.anchors.byId(anchor.id);
    expect(persisted.ext_scope).toBe('cidTRIGGER');
    expect(persisted.context).toEqual({ sent_to: 'cidTRIGGER', ref_msg_id: 'msgTRIGGER' });
    expect(typeof persisted.context).not.toBe('string');

    // ③ 有一条入站回复 → replyInChain 就近引用它，并回到同一会话（真发路径用假 bin）
    recordReply(s, persisted, { ext_id: 'msgHUMAN1', text: '开吧', at: new Date(T1400 + 60e3).toISOString() });
    const log = join(TMP, `calls-${Math.random().toString(36).slice(2)}.log`);
    const bin = fakeReplyDws(log);

    const prev = process.env.DWS_HUB_ENABLE;
    process.env.DWS_HUB_ENABLE = '1';
    try {
      const out = await replyInChain(s, { anchorId: anchor.id, text: '已开通', bin });
      expect(out.ok).toBe(true);
      const { readFileSync } = require('node:fs');
      const argLines = readFileSync(log, 'utf8').trim().split('\n');
      const replyLine = argLines.find((l) => l.includes('+messages-reply'));
      expect(replyLine).toBeTruthy();
      expect(replyLine).toContain('--group cidTRIGGER');       // 会话来自锚点，不是空串
      expect(replyLine).toContain('--ref-msg-id msgHUMAN1');   // 就近成链：最近入站
      // ④ 出站落账 + 状态推进
      const after = s.anchors.byId(anchor.id);
      expect(after.replies.at(-1).direction).toBe('out');
      expect(after.replies.at(-1).extId).toBe('sent-reply-1');
      expect(after.status).toBe('acting');
    } finally {
      if (prev === undefined) delete process.env.DWS_HUB_ENABLE;
      else process.env.DWS_HUB_ENABLE = prev;
    }
  });

  test('非 reply 场景：会话字段为 null（不污染 self 语义）', async () => {
    const s = openStore(':memory:');
    const r = await notify(s, { consumer: 'x', title: '请决策', needsDecision: true, now: T1400 });
    expect(r.anchor.scope).toBe('self');
    expect(r.anchor.ext_scope).toBeNull();
    expect(r.anchor.context).toBeNull();
  });

  test('历史锚点（context 存成 JSON 字符串）读回仍是对象（兼容旧数据）', () => {
    const s = openStore(':memory:');
    const legacy = s.anchors.insert({
      id: 'anchor-2026-10-01-001', created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z',
      consumer: 'x', strength: 'info', needs_decision: true, title: '旧锚点', status: 'open',
      scope: 'conversation', ext_id: 'msgOLD', confirmed: false,
      // 旧实现：JSON.stringify 后又被 store 序列化一次 → 读回是字符串
      context: JSON.stringify({ sent_to: 'cidOLD', ref_msg_id: 'msgOLD' }), replies: [],
    });
    const back = s.anchors.byId(legacy.id);
    expect(typeof back.context).toBe('object');
    expect(back.context.sent_to).toBe('cidOLD');
  });
});
