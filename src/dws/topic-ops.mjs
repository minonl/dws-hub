/**
 * topic-ops.mjs —— 主题能力的渠道侧操作（dws 适配，2026-11-06）
 *
 * 与 `hub/topic.mjs` 的分工：
 *   · hub/topic.mjs = 渠道无关（主题/会话/消息账本、候选筛选）；
 *   · 本文件 = 渠道动作（撤回、投递查询、发送并记账）。
 *
 * 撤回安全约束（用户 2026-11-06）：
 *   1. 只允许撤回**我方出站账本里**的候选（调用方先 recallCandidates）；
 *   2. 必须精确 `--confirm <extId>` 命中唯一候选；
 *   3. 默认 dry-run，`--yes` 仅跳过二次交互、不跳过候选校验。
 */
import { dwsJson } from './dws.mjs';
import { chatMessages } from './query.mjs';
import { sendDirect, sendGroup } from './send.mjs';

/** 从发送响应里提取 messageId / openTaskId（信封因命令而异，宽容匹配）。 */
export function extractSendResult(r) {
  const raw = r?.raw || JSON.stringify(r?.data ?? '');
  const messageId = /"messageId"\s*:\s*"([^"]+)"/.exec(raw)?.[1]
    || /"openMessageId"\s*:\s*"([^"]+)"/.exec(raw)?.[1]
    || null;
  const openTaskId = /"openTaskId"\s*:\s*"([^"]+)"/.exec(raw)?.[1] || null;
  return { messageId, openTaskId, ok: Boolean(r?.ok) || /"success"\s*:\s*true|"ok"\s*:\s*true/.test(raw) };
}

/** 撤回一条消息（调用方必须已完成候选确认）。 */
export async function recallMessage({ msgId, conversationId, bin } = {}) {
  if (!msgId) throw new Error('recallMessage：缺少 msgId');
  const args = ['chat', '+messages-recall', '--msg-id', String(msgId)];
  if (conversationId) args.push('--conversation-id', String(conversationId));
  args.push('--yes', '--format', 'json');
  const r = await dwsJson(args, { bin, timeoutMs: 60_000 });
  return { ok: r.ok, raw: r.raw || '', data: r.data };
}

/** 查询发送任务投递状态。 */
export async function querySendStatus({ openTaskId, bin } = {}) {
  if (!openTaskId) throw new Error('querySendStatus：缺少 openTaskId');
  const r = await dwsJson(
    ['chat', '+messages-query-send-status', '--open-task-id', String(openTaskId), '--format', 'json'],
    { bin, timeoutMs: 60_000 },
  );
  return { ok: r.ok, raw: r.raw || '', data: r.data };
}

/**
 * 在主题的某个会话里发送消息（并返回可记账的 id）。
 * @param {{scope: string, kind?: 'group'|'direct', text: string, at?: string[]}} opts
 *   scope：群 = conversationId；单聊 = `dm:<openDingTalkId>` 或直接 openDingTalkId（kind=direct 时）
 */
export async function sendToThread({ scope, kind = 'group', text, at = [], bin, uuid } = {}) {
  if (!scope) throw new Error('sendToThread：缺少 scope');
  if (kind === 'direct') {
    const openId = String(scope).replace(/^dm:/, '');
    const r = await sendDirect(openId, text, { bin, uuid });
    return { ...extractSendResult(r), scope, kind };
  }
  const r = await sendGroup(String(scope), text, at, { bin, uuid });
  return { ...extractSendResult(r), scope, kind };
}


/**
 * 拉取某会话的消息（群 = scope；单聊 = ext_ref 里的 conversationId）。
 * @param {{scope: string, kind?: 'group'|'direct', extRef?: string, since?: string, limit?: number}} opts
 */
export async function pullThreadMessages({ scope, kind = 'group', extRef = null, since, limit = 50, bin } = {}) {
  if (kind === 'direct') {
    const convId = extRef || (String(scope).startsWith('dm:') ? null : String(scope));
    if (!convId) {
      throw new Error('单聊拉取需要 conversationId：link 时传 --conversation-id <cid>（可先用 recent-conversations 找）');
    }
    return chatMessages({ conversationId: convId, since, limit, bin });
  }
  return chatMessages({ group: String(scope), since, limit, bin });
}
