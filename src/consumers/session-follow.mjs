#!/usr/bin/env bun
/**
 * dws-hub consumer：把订阅会话的新消息投递到**调用方自己的** inbox
 *
 * 本模块不绑定任何 agent 框架：投递方式由命令模板 `DWS_HUB_INBOX_CMD` 决定（未配置 = 只落日志）。
 * 注册：`dws-hub follow add --scope group:<cid>` → `dws-hub follow sync`
 *
 * stdin: `{"consumer":"session-follow","events":[{ext_id,scope,sender,text,at,source,reply_to,outbound,meta}]}`
 * 退出码：0 = 成功（推进游标）；非 0 = 失败（hub 指数退避重试，不丢）
 *
 * 幂等：模板里使用 `$DWS_HUB_INBOX_KEY`（值形如 `dws:<ext_id>:<session>`）作为去重键。
 *
 * 模板可用的环境变量（由本模块注入，消息正文**只走环境变量**，不做字符串拼接，避免引号注入）：
 *   DWS_HUB_INBOX_TO / FROM / KIND / SUBJECT / BODY / THREAD / KEY / EXT_ID / SCOPE
 *
 * 示例：
 *   DWS_HUB_INBOX_CMD='inbox-cli add --to "$DWS_HUB_INBOX_TO" --subject "$DWS_HUB_INBOX_SUBJECT" \
 *     --body "$DWS_HUB_INBOX_BODY" --idempotency-key "$DWS_HUB_INBOX_KEY"'
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { loadFollows, sessionsForEvent } from '../hub/follows.mjs';

/** 数据根（与 hub/store.mjs 同口径）。 */
export function dataRoot() {
  return process.env.DWS_HUB_HOME || join(homedir(), '.dws-hub');
}

/** 投递命令模板；未配置 → 返回空串（只记日志，不丢数据）。 */
export function inboxCommand() {
  return String(process.env.DWS_HUB_INBOX_CMD || '').trim();
}

/** 未投递消息的落盘位置：`<root>/logs/inbox-skipped-<YYYY-MM-DD>.jsonl` */
export function skippedLogPath(now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  return join(dataRoot(), 'logs', `inbox-skipped-${day}.jsonl`);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      buf += c;
    });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

function localTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || '';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: process.env.DWS_HUB_TZ || 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .format(d)
      .replace(/\//g, '-');
  } catch {
    return iso;
  }
}

function truncate(text, max = 3500) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max)}\n…（已截断）` : s;
}

/** 自己的身份（服务环境里由 plist/env 注入）——自己的消息不再回灌 inbox。 */
function selfIdentities() {
  return {
    ids: new Set([process.env.DWS_HUB_SELF_OPEN_ID, process.env.DWS_HUB_SELF_USER].filter(Boolean).map(String)),
    names: new Set([process.env.DWS_HUB_SELF_NAME].filter(Boolean).map(String)),
  };
}

function isSelfEvent(event, self) {
  const senderId = event.meta?.senderId ? String(event.meta.senderId) : '';
  if (senderId && self.ids.has(senderId)) return true;
  if (event.sender && self.names.has(String(event.sender))) return true;
  return false;
}

function buildMessage(event, hit) {
  const label = hit.entry?.label || event.scope;
  const sender = event.sender || '未知';
  const subject = `[钉钉] ${label} · ${sender}`.slice(0, 120);
  const body = [
    `会话：${label}`,
    `发送人：${sender}`,
    `时间：${localTime(event.at)}`,
    `scope：${event.scope}`,
    '',
    truncate(event.text),
  ].join('\n');
  return { subject, body };
}

/** 未配置投递命令时落盘，供人事后补投（`follow status` 会报当日条数）。 */
function recordSkipped(record) {
  const file = skippedLogPath();
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(record)}\n`);
}

/**
 * @param {object} [deps] 测试可注入
 * @param {string} [deps.input] 直接给 stdin 内容
 * @param {NodeJS.ProcessEnv} [deps.env]
 */
export async function main(deps = {}) {
  const env = deps.env || process.env;
  const raw = deps.input ?? (await readStdin());
  const out = deps.stdout || process.stdout;

  if (!raw.trim()) {
    out.write(`${JSON.stringify({ ok: true, delivered: 0, note: 'empty stdin' })}\n`);
    return 0;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    (deps.stderr || process.stderr).write(`session-follow: 非法 stdin JSON: ${e?.message || e}\n`);
    return 2;
  }

  const events = Array.isArray(payload.events) ? payload.events : [];
  const doc = loadFollows();
  const self = selfIdentities();
  const cmd = inboxCommand();
  const from = env.DWS_HUB_INBOX_FROM || 'dws-hub';
  const delivered = [];
  const skipped = [];
  const failed = [];
  let recorded = 0;

  for (const event of events) {
    if (isSelfEvent(event, self)) {
      skipped.push(event.ext_id);
      continue;
    }
    const hits = sessionsForEvent(doc, event);
    if (!hits.length) {
      skipped.push(event.ext_id);
      continue;
    }
    for (const hit of hits) {
      const { subject, body } = buildMessage(event, hit);
      const key = `dws:${event.ext_id}:${hit.session}`;
      // 稳定 thread：去重键只在同一 thread 内生效，不能每次生成新 thread
      const thread = `th-follow-${createHash('sha1').update(`${hit.session}\0${hit.scope}`).digest('hex').slice(0, 12)}`;

      if (!cmd) {
        recordSkipped({ at: new Date().toISOString(), key, to: hit.session, scope: hit.scope, subject, body });
        recorded += 1;
        skipped.push(event.ext_id);
        continue;
      }

      try {
        execFileSync('/bin/sh', ['-c', cmd], {
          encoding: 'utf8',
          timeout: 15000,
          env: {
            ...env,
            DWS_HUB_INBOX_TO: hit.session,
            DWS_HUB_INBOX_FROM: from,
            DWS_HUB_INBOX_KIND: 'notify',
            DWS_HUB_INBOX_SUBJECT: subject,
            DWS_HUB_INBOX_BODY: body,
            DWS_HUB_INBOX_THREAD: thread,
            DWS_HUB_INBOX_KEY: key,
            DWS_HUB_INBOX_EXT_ID: String(event.ext_id),
            DWS_HUB_INBOX_SCOPE: String(event.scope),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        delivered.push({ session: hit.session, ext_id: event.ext_id, scope: event.scope });
      } catch (e) {
        failed.push({
          session: hit.session,
          ext_id: event.ext_id,
          error: String(e?.stderr || e?.message || e).slice(0, 500),
        });
      }
    }
  }

  const noInbox = !cmd;
  const summary = {
    ok: failed.length === 0,
    delivered: delivered.length,
    skipped: skipped.length,
    failed,
    ...(noInbox
      ? {
          note: recorded > 0
            ? `DWS_HUB_INBOX_CMD 未配置：${recorded} 条已落 logs/inbox-skipped-*.jsonl`
            : 'DWS_HUB_INBOX_CMD 未配置：本次没有需要投递的消息（未命中订阅或为本人消息）',
        }
      : {}),
  };
  out.write(`${JSON.stringify(summary)}\n`);
  if (noInbox && recorded > 0) {
    (deps.stderr || process.stderr).write(
      'session-follow: DWS_HUB_INBOX_CMD 未配置，消息只落盘未投递（见 logs/inbox-skipped-*.jsonl）\n',
    );
  }
  if (failed.length) {
    (deps.stderr || process.stderr).write(`session-follow: ${failed.length} 条投递失败，等待 hub 重试\n`);
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`session-follow: ${e?.stack || e}\n`);
      process.exit(1);
    });
}
