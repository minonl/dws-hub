/**
 * query.mjs —— 钉钉「会话 / 消息 / 登录态」查询（dws-hub L1 能力，2026-11-06）
 *
 * 覆盖 `dws` 的 auth status / recent-conversations / chat-messages / search-msg 四类读取。
 *
 * 只做「读取」：不写状态、不缓存（缓存留在调用方）。
 */
import { dwsJson } from './dws.mjs';

/* ═══════════════════════════════════════════════════════════════════════════
 * 严格 JSON 信封（docs/design.md #2）
 *
 * `dwsJson` 为兼容 dws 的「进度行 + JSON」会在**整段解析失败后逐行兜底**，这对
 * 「日志行 + 空结果」是有害的：`paging 1/20 ...\n{"messages":[]}` 会被兜底成
 * 「读到了空结果」→ 调用方推进水位 → 整窗消息永久漏读。
 *
 * 故 query 层（只读查询）**只用严格模式**：`raw` 整体 `JSON.parse` 必须得到
 * **单个对象**；多行日志混排 / NDJSON / 裸标量 / 数组 → 一律按解析失败（上游故障）处理。
 * ⚠️ 仍保留 dws「JSON 走 stderr」兜底（坑 1）：`dwsJson` 的 `raw` 是**解析成功的那一路**
 *    原文，所以 `stdout 噪声 + stderr 整段 JSON` 依旧是合法的严格输入。
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 严格解析：整体必须是单个 JSON 对象，否则返回 `null`。 */
export function parseStrictJson(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  let v;
  try { v = JSON.parse(s); } catch { return null; }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  return v;
}

/**
 * 把 `dwsJson` 的结果收敛成严格信封：整段不可解析 → `ok:false` + `data._raw`
 * （复用既有 `isUnparsable` / `mapDwsExit` 口径 ⇒ 统一映射到 hub code 3）。
 * 无任何输出（超时 / spawn 失败）时原样返回，交给 `mapDwsExit` 按 `code:null` 处理。
 */
export function strictEnvelope(r) {
  const raw = String(r?.raw ?? '').trim();
  if (!raw) return r;
  const payload = parseStrictJson(raw);
  if (!payload) return { ...r, ok: false, parsed: false, data: { _raw: raw.slice(0, 400) } };
  return { ...r, data: payload };
}

function unwrap(r, what) {
  const strict = strictEnvelope(r);
  const payload = strict.data || {};
  // 不能只看 r.ok：`exit 0` 也可能是失败（信封 ok:false/success:false/outcome:failure、非空 error、
  // 或输出不可解析只剩 `_raw`）。漏判 = 把失败当「空结果」→ 调用方按 0 条处理 → 漏 MR review。
  const declared = payload.ok === false || payload.success === false || payload.outcome === 'failure';
  if (!strict.ok || declared || isUnparsable(payload) || hasErrorEnvelope(payload)) {
    const detail = (r.raw || '').slice(0, 300) || payload.error?.message || `exit ${r.code}`;
    const err = new Error(`${what} 失败：${detail}`);
    // 统一走 hub 契约码（0/2/3/4），**不透传** dws 原始码（docs/design.md / docs/design.md）
    const mapped = mapDwsExit(r);
    err.code = mapped.code;
    err.retryable = mapped.retryable;
    err.data = payload;
    throw err;
  }
  return payload;
}

/** 登录态：{authenticated, token_valid, refresh_expires_at, user_name, ...} */
export async function authStatus({ bin } = {}) {
  return unwrap(await dwsJson(['auth', 'status', '--format', 'json'], { bin }), 'auth status');
}

/** 最近会话（服务端慢，20~30s）→ conversations[] */
export async function recentConversations({ since, limit = 100, bin } = {}) {
  const args = ['chat', '+recent-conversations', '--limit', String(limit), '--format', 'json'];
  if (since) args.push('--start', String(since));
  const d = unwrap(await dwsJson(args, { bin, timeoutMs: 90_000 }), 'chat +recent-conversations');
  return d.conversations || d.data?.conversations || [];
}

/**
 * 会话消息 → messages[]
 *
 * 会话目标三选一（优先级 user > group > conversationId）：
 *   --user <userId>            按单聊对方 userId 拉（dws 原生参数）
 *   --group <cid|群名>         按群拉
 *   --conversationId <cid>     兼容既有调用方（历史姿势，保持原样）
 *
 * limit：显式传入才加 `--limit`；未传时 pageAll 走服务端翻页（不注入默认值，防截断），
 *        非 pageAll 仍保持历史默认 100（与 dws 自身默认一致）。
 */
export async function chatMessages({
  user, group, conversationId, since, end, order, limit, pageAll = false, pageLimit,
  noReactions = false, bin,
} = {}) {
  let target = null;
  if (user) target = ['--user', String(user)];
  else if (group) target = ['--group', String(group)];
  else if (conversationId) target = ['--conversation-id', String(conversationId)];
  if (!target) throw new Error('chatMessages：需要 user / group / conversationId 之一');

  const args = ['chat', '+chat-messages', ...target];
  const lim = limit ?? (pageAll ? null : 100);
  if (lim != null) args.push('--limit', String(lim));
  if (since) args.push('--start', String(since));
  if (end) args.push('--end', String(end));
  if (order) args.push('--order', String(order));
  if (pageAll) args.push('--page-all');
  if (pageLimit != null) args.push('--page-limit', String(pageLimit));
  if (noReactions) args.push('--no-reactions');
  args.push('--format', 'json');

  const d = unwrap(await dwsJson(args, { bin, timeoutMs: 90_000 }), 'chat +chat-messages');
  return d.messages || d.data?.messages || [];
}

/** 群名 → 群列表（`chat +chat-search`）→ chats[] */
export async function chatSearch({ query, limit, pageAll = false, pageLimit, bin } = {}) {
  if (!query) throw new Error('chatSearch：缺少 query（群名关键词）');
  const args = ['chat', '+chat-search', '--query', String(query)];
  if (limit != null) args.push('--limit', String(limit));
  if (pageAll) args.push('--page-all');
  if (pageLimit != null) args.push('--page-limit', String(pageLimit));
  args.push('--format', 'json');
  const d = unwrap(await dwsJson(args, { bin, timeoutMs: 90_000 }), 'chat +chat-search');
  return d.chats || d.data?.chats || [];
}

/**
 * 群内 / 单聊关键词搜索（`chat +search-msg`）→ messages[]
 *
 * since/end/order/allTime/limit/pageAll 均按需透传（不注入默认值：`--limit` 省略时
 * 由 dws 自身默认 100，避免改变既有查询窗口）。
 */
export async function searchMessages({
  group, conversationId, query, allTime = false, days, since, end, order, limit,
  pageAll = false, pageLimit, atMe = false, noReactions = false, bin,
} = {}) {
  if (!query) throw new Error('searchMessages：缺少 query（搜索关键词）');
  const args = ['chat', '+search-msg', '--query', String(query)];
  if (atMe) args.push('--at-me');
  if (group) args.push('--group', String(group));
  // `+search-msg` 无 `--conversation-id`；按 openConversationId 收窄请用 `--chat-id`（与上游别名一致）
  else if (conversationId) args.push('--chat-id', String(conversationId));
  // 注意：--all-time 与 --days/--start 语义冲突，显式传 allTime 时不再追加时间窗
  if (allTime) args.push('--all-time');
  else {
    if (days != null) args.push('--days', String(days));
    if (since) args.push('--start', String(since));
  }
  if (end) args.push('--end', String(end));
  if (order) args.push('--order', String(order));
  if (limit != null) args.push('--limit', String(limit));
  if (pageAll) args.push('--page-all');
  if (pageLimit != null) args.push('--page-limit', String(pageLimit));
  if (noReactions) args.push('--no-reactions');
  args.push('--format', 'json');
  const d = unwrap(await dwsJson(args, { bin, timeoutMs: 180_000 }), 'chat +search-msg');
  return d.messages || d.data?.messages || [];
}

/** @我 的消息（可选限定群）→ messages[] */
export async function searchAtMe({ group, days = 7, pageAll = true, bin } = {}) {
  const args = ['chat', '+search-msg', '--at-me', '--days', String(days)];
  if (pageAll) args.push('--page-all');
  if (group) args.push('--group', String(group));
  const d = unwrap(await dwsJson(args, { bin, timeoutMs: 180_000 }), 'chat +search-msg');
  return d.messages || d.data?.messages || [];
}

/* ═══════════════════════════════════════════════════════════════════════════
 * P2-1：读类查询补口（chatList / directMessages / atMe）+ 退出码显式映射
 * 设计：docs/design.md（契约码 0/2/3/4）
 *
 * 纪律：
 *   · 既有导出（authStatus / recentConversations / chatMessages / chatSearch /
 *     searchMessages / searchAtMe）签名与返回形态**不变**，不走这里的映射；
 *   · 新函数复用 dwsJson，但错误按 hub 契约码抛出（**禁止透传 dws 原始码**）；
 *   · 只读：不写游标、不写库。
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 参数错误（hub code 2，确定性错误，不可重试）。 */
function badRequest(msg) {
  const err = new Error(msg);
  err.code = 2;
  err.retryable = false;
  throw err;
}

/** 鉴权类错误判定：结构化 category 优先，其次文案兜底。 */
function isAuthError(data) {
  const e = data?.error || {};
  if (e.category === 'auth') return true;
  const text = `${e.reason || ''} ${e.message || ''} ${e.type || ''}`;
  return /unauthoriz|authentication|invalid[\s_-]?token|token[\s_-]?(expired|invalid)|鉴权|未授权|授权失效|登录态失效/i
    .test(text);
}

/** 信封是否带非空 `error` 对象（成功响应不会带）。 */
function hasErrorEnvelope(data) {
  const e = data?.error;
  return Boolean(e) && typeof e === 'object' && Object.keys(e).length > 0;
}

/**
 * 输出是否**根本不可解析**（`dwsJson` 的 `_raw` 兜底 / 显式 `parse_error`）。
 *
 * ⚠️ `exit 0` + 非 JSON 只能是上游/环境故障，**绝不允许**当数据放行：
 *    否则会退化成 `{messages: [], complete: true}`（假成功）→ 调用方推进水位 → 永久漏读。
 */
function isUnparsable(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (payload._raw !== undefined) return true;
  return payload.error?.type === 'parse_error';
}

/** 信封是否自报失败（`exit 0` 也可能是失败，docs/design.md）。 */
function envelopeFailed(data) {
  if (data?.ok === false || data?.success === false || data?.outcome === 'failure') return true;
  return hasErrorEnvelope(data);
}

/**
 * dws 退出码 → hub 契约码（docs/design.md）。**禁止透传** dws 原始码。
 *
 * ⚠️ `exit 0` **不等于**成功：dws 有时退出码 0 却在信封里写
 *    `{success:false}` / `{ok:false}` / `{error:{...}}`（假成功）→ 必须按上游失败处理，
 *    否则调用方会把「没读到东西」当「读到了空结果」。
 * ⚠️ `exit 2` 是 dws CLI 自身的 catch 哨兵（bug 信号）：map 成 hub 3 但
 *    **retryable=false**（自动重试只会掩盖 bug）；而 `null`（超时/spawn 失败）仍可重试。
 *
 * @param {{code?:number|null, data?:object}} r dwsJson 的返回片段
 * @returns {{code:0|2|3|4, retryable:boolean}}
 */
export function mapDwsExit({ code, data } = {}) {
  // 鉴权失效优先于退出码（dws 可能是 1 或其它非 0）
  if (isAuthError(data)) return { code: 4, retryable: false };
  // 输出不可解析（只有 `_raw` 噪声）→ 上游/环境故障：不是参数错误，也**绝不是成功**
  // 只读查询重试是安全的（不产生副作用）→ retryable=true
  if (isUnparsable(data)) return { code: 3, retryable: true };
  const category = data?.error?.category;
  if (code === 0) {
    // 退出码 0 但信封自报失败 → 上游失败（validation 仍归参数错误）
    if (envelopeFailed(data)) {
      if (category === 'validation') return { code: 2, retryable: false };
      return { code: 3, retryable: true };
    }
    return { code: 0, retryable: false };
  }
  // validation（未知 flag / 缺必填 / 冲突 / 越界）→ 参数错误，重试必然同错
  if (code === 3 || category === 'validation') return { code: 2, retryable: false };
  // 2 = dws CLI 自身 catch 哨兵（未分类异常/bug）→ 上游失败但**不自动重试**
  if (code === 2) return { code: 3, retryable: false };
  // 1 = api 业务错误、null = 超时/spawn 失败、未知 → 上游失败（由调用方按 reason 决定）
  return { code: 3, retryable: true };
}

/** 取 payload 中非空数组（兼容顶层与 `data.*` 包裹）；空数组不算「可用数据」。 */
function nonEmptyArray(payload, key) {
  const top = payload?.[key];
  if (Array.isArray(top) && top.length > 0) return top;
  const nested = payload?.data?.[key];
  if (Array.isArray(nested) && nested.length > 0) return nested;
  return null;
}

/**
 * 按契约码抛错；但**抢救解析**：dws 非 0 却给出了可用 payload（典型
 * `+chat-list` 翻到尽头 pagination_error + exit 1 但 stdout 完整）时，
 * 交给调用方以 complete=false + stopReason 返回，不把不可用当可用、也不白丢数据。
 *
 * ⚠️ 抢救门槛 = **非空数组**（`[]` 不算数据）：上游失败时 stdout 里常带
 *    `{"error":{...},"messages":[]}` 这类「空结果信封」，若把空数组当可用 payload
 *    就会把失败伪装成 `{messages: [], complete: true}` → 调用方按docs/design.md 推进水位，
 *    整段消息永久漏读（docs/design.md 硬禁令）。空数组 + 非 0 一律走契约码抛错。
 *    抢救成功的 payload 一律标 `complete: false`（不许假设完整）。
 *    但信封**自报失败**（`ok:false` / `success:false` / `outcome:'failure'` / 非空 `error`）时**一律不抢救**：
 *    那说明「这是失败响应」，即使带了数组也不能当可用数据。
 *    ⚠️ `dwsJson` 的 `ok` 只看 `code===0 && 解析成功 && !(ok/success/outcome 失败)`，**不看 `error` 是否非空**
 *    ⇒ «exit 0 + 非空 error» 必须在这里再判一次，否则假成功会漏进调用方。
 *    ⚠️ «exit 0 + 输出不可解析»（payload 只剩 `_raw`）同样必须判失败 —— 那不是「读到了空」。
 */
function unwrapMapped(rIn, what, { salvageKeys = [] } = {}) {
  const r = strictEnvelope(rIn);
  const payload = r.data || {};
  const declared = payload.ok === false || payload.success === false || payload.outcome === 'failure';
  // 解析失败（payload 只有 `_raw` 噪声）**一律按失败处理**：哪怕 r.ok 因 exit 0 为真，
  // 也不许放行成空结果（docs/design.md 假成功禁令）。
  const unparsable = isUnparsable(payload);
  // r.ok 也可能是假成功（exit 0 + 非空 error 信封）→ 与 mapDwsExit 同口径，一律按失败处理
  if (r.ok && !unparsable && !declared && !hasErrorEnvelope(payload)) return payload;
  const mapped = mapDwsExit(r);
  // 只有「dws 自身非 0」才允许抢救；r.ok 却自报失败 / 输出不可解析 / 信封带非空 `error`
  // 一律**不抢救**——那是失败响应，即使带了非空数组也不能当可用数据（error 为准判失败）。
  const salvaged = !r.ok && !unparsable && !declared && !hasErrorEnvelope(payload)
    && salvageKeys.some((k) => nonEmptyArray(payload, k));
  if (salvaged && mapped.code === 3) return { ...payload, complete: false }; // 部分成功：显式标不完整
  const detail = (r.raw || '').slice(0, 300) || payload.error?.message || `exit ${r.code}`;
  const err = new Error(`${what} 失败：${detail}`);
  err.code = mapped.code;
  err.retryable = mapped.retryable;
  err.data = payload;
  throw err;
}

/** payload 取数组：兼容 `d.conversations` 与 `d.data.conversations` 两种包裹。 */
function pickArray(d, key) {
  if (Array.isArray(d?.[key])) return d[key];
  if (Array.isArray(d?.data?.[key])) return d.data[key];
  return [];
}

/** payload 取标量：兼容顶层与 `data.*` 包裹。 */
function pickField(d, key) {
  const v = d?.[key];
  if (v !== undefined && v !== null) return v;
  return d?.data?.[key];
}

/**
 * 完整性信号（`complete`）——显式优先，缺省按分页语义推断：
 * truncated 反向、stopReason 归类；都没有时「开了 page-all」才视为可能完整。
 */
function pickComplete(d, { pageAll } = {}) {
  const complete = pickField(d, 'complete');
  if (typeof complete === 'boolean') return complete;
  const truncated = pickField(d, 'truncated');
  if (typeof truncated === 'boolean') return !truncated;
  const stopReason = pickField(d, 'stopReason');
  if (stopReason) return /^(complete|end|finish)/i.test(String(stopReason));
  return pageAll === true;
}

/** 分页 loop 上限（dws 侧是「最大页数」，不是页大小）。 */
function assertPageLimit(pageLimit, max = 500, label = 'pageLimit') {
  if (pageLimit == null) return;
  if (!Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > max) {
    badRequest(`${label} 必须是 1..${max} 的整数（dws 侧为「最大页数」），收到 ${pageLimit}`);
  }
}

/** chatList 的 hub 侧页数上限（dws 服务端 1..500，hub 收敛到 20 页 = 2000 会话）。 */
const CHAT_LIST_MAX_PAGES = 20;

/**
 * 会话列表（`chat +chat-list`）→ { conversations, complete, stopReason }
 *
 * @param {object} opts
 * @param {string[]} [opts.types=['group','p2p']] 会话类型（group / p2p）
 * @param {number} [opts.pageSize] 每页大小 1..100（dws 硬限；显式传入才加 `--page-size`）
 * @param {boolean} [opts.pageAll=true] 连续翻页
 * @param {number} [opts.pageLimit=20] 最大页数 1..20（hub 策略上限：2000 个会话；超过 → 参数错误）
 * @param {boolean} [opts.excludeMuted] 排除免打扰会话
 * @param {boolean} [opts.bin] dws 可执行文件
 */
export async function chatList({
  types = ['group', 'p2p'], pageSize, limit, pageAll = true, pageLimit = 20,
  excludeMuted = false, bin,
} = {}) {
  if (!Array.isArray(types) || types.length === 0) badRequest('chatList：types 必须是非空数组');
  const size = pageSize ?? limit;
  if (size != null && (!Number.isInteger(size) || size < 1 || size > 100)) {
    badRequest(`chatList：pageSize 必须是 1..100 的整数（dws 服务端硬限），收到 ${size}`);
  }
  // dws 服务端允许 1..500 页，但 hub 侧对 chatList 收敛到 20 页（docs/design.md C1 有界性）
  assertPageLimit(pageLimit, CHAT_LIST_MAX_PAGES, 'chatList：pageLimit（pageAll 最多 20 页）');

  const args = ['chat', '+chat-list', '--types', types.join(',')];
  if (size != null) args.push('--page-size', String(size));
  if (pageAll) args.push('--page-all', '--page-limit', String(pageLimit));
  if (excludeMuted) args.push('--exclude-muted');
  args.push('--format', 'json');

  const d = unwrapMapped(await dwsJson(args, { bin, timeoutMs: 90_000 }), 'chat +chat-list', {
    salvageKeys: ['conversations', 'chats'],
  });
  const conversations = pickArray(d, 'conversations').length
    ? pickArray(d, 'conversations')
    : pickArray(d, 'chats');
  const stopReason = pickField(d, 'stopReason') ?? null;
  return {
    conversations,
    complete: pickComplete(d, { pageAll }) && !stopReasonIsError(stopReason),
    stopReason,
  };
}

/**
 * stopReason 是否表示「没拉全」：
 *   · 上游报错类（error / fail / timeout / truncat）
 *   · 打满页数上限（page_limit / max_pages / limit_reached）——dws 翻页到 `--page-limit` 即停
 * 命中即 `complete=false`（不许把截断当完整）。
 */
function stopReasonIsError(stopReason) {
  return Boolean(stopReason) && /error|fail|timeout|truncat|page.?limit|max.?page|limit.?reached/i.test(String(stopReason));
}

/**
 * 单聊（自聊）消息（`chat +messages-list-direct`）→ { messages, complete, cursor }
 *
 * ⚠️ 该命令**没有** `--start`/`--end`：`--time` 是**起点**（必填），
 *    方向由 `--forward` 决定（默认 true = 从 t 往现在拉）。
 *
 * **窗口契约**（docs/design.md C2）：
 *   · `forward=true`（默认）：`--time = since`，窗口 `[since, now)`；
 *     若给了 `end`，结果再按 `at <= end` **客户端过滤**（dws 无 `--end`）。
 *   · `forward=false`：向过去拉，`--time` 起点 = **`end`**（推荐，显式给出「上界」→ 窗口 `(过去, end]`）；
 *     未给 `end` 时退回 `--time = since`（兼容旧调用 = 从 since 往过去拉），**不静默改成往现在拉**。
 *   两种方向都**显式**传 flag（`--forward` / `--forward=false`）。
 *
 * @param {object} opts
 * @param {string} [opts.user] 对方/自己的 userId（与 openDingTalkId 二选一）
 * @param {string} [opts.openDingTalkId] 对方 openId（与 user 二选一）
 * @param {string} opts.since 占比窗口起点（必填；forward=false 且给了 end 时退为「窗口下界」用途）
 * @param {string} [opts.end] 窗口上界（ISO / `YYYY-MM-DD HH:mm:ss`）
 * @param {boolean} [opts.forward=true] 方向：true 往现在拉（`[since, now)`），false 往过去拉（`(过去, time]`）。
 *   两种方向都**显式**传 flag（`--forward` / `--forward=false`）——dws 默认 true，省略即反向。
 * @param {boolean} [opts.pageAll=true] 连续翻页
 * @param {number} [opts.pageLimit=100] 最大页数 1..500
 * @param {number} [opts.limit] 页大小（>0，显式传入才加 `--limit`）
 * @param {boolean} [opts.noReactions] 不返回表情回应
 * @param {string} [opts.bin] dws 可执行文件
 */
export async function directMessages({
  user, openDingTalkId, since, end, forward = true, pageAll = true, pageLimit = 100,
  limit, noReactions = false, bin,
} = {}) {
  if (user && openDingTalkId) badRequest('directMessages：user 与 openDingTalkId 互斥（只能给一个）');
  if (!user && !openDingTalkId) badRequest('directMessages：需要 user 或 openDingTalkId 之一');
  if (since == null || since === '') badRequest('directMessages：缺少 since（dws --time 为必填起始时间）');
  // 窗口合法性：since/end 都能解析且 since >= end → 空窗（确定性参数错误，重试同错）。
  // ⚠️ 解析不了的时间串**不拦**：`YYYY-MM-DD HH:mm:ss` 在不同平台可解析性有差异，
  //    宁可交给 dws 自己校验，也不在这里误伤格式差异。
  const sinceMs = toMillis(since);
  const endMs = toMillis(end);
  if (sinceMs != null && endMs != null && sinceMs >= endMs) {
    badRequest(`directMessages：since 必须早于 end（收到 since=${since} / end=${end}）`);
  }
  if (limit != null && (!Number.isInteger(limit) || limit < 1)) {
    badRequest(`directMessages：limit（页大小）必须是正整数，收到 ${limit}`);
  }
  assertPageLimit(pageLimit, 500, 'directMessages：pageLimit');

  const args = ['chat', '+messages-list-direct'];
  if (user) args.push('--user', String(user));
  else args.push('--open-dingtalk-id', String(openDingTalkId));
  // `--time` 永远是**起点**（不是上界）：反向读时起点 = 调用方给的上界 end
  const timeStart = forward === false && end ? end : since;
  args.push('--time', String(timeStart));
  // 方向必须**显式**表达：dws 的 `--forward` 默认 true，省略 flag 等于「往现在拉」
  // ⇒ forward=false 若被省略就静默反向（读成 [since, now) 而非 (过去, time]），漏读历史 + 与既有窗口重复。
  args.push(forward ? '--forward' : '--forward=false');
  if (limit != null) args.push('--limit', String(limit));
  if (pageAll) args.push('--page-all', '--page-limit', String(pageLimit));
  if (noReactions) args.push('--no-reactions');
  args.push('--format', 'json');

  const d = unwrapMapped(await dwsJson(args, { bin, timeoutMs: 90_000 }), 'chat +messages-list-direct', {
    salvageKeys: ['messages'],
  });
  let messages = pickArray(d, 'messages');
  // dws 没有 `--end`：正向读（[since, now)）需要按 `end` 在客户端收窄
  if (forward !== false && end) messages = messages.filter((m) => !isAfter(m, end));
  const stopReason = pickField(d, 'stopReason') ?? null;
  return {
    messages,
    // 恒含 complete：显式优先，其次分页推断；打满页数（page_limit）一律不完整
    complete: pickComplete(d, { pageAll }) && !stopReasonIsError(stopReason),
    cursor: pickField(d, 'cursor') ?? null,
    stopReason,
  };
}

/**
 * 宽松时间解析 → UTC 毫秒（不可解析 → `null`）。
 *
 * 必须覆盖 dws 实际返回的三种口径（docs/design.md）：
 *   · **毫秒数字**（`createTime: 1762732800000`，`+messages-list-direct` 实测口径）
 *   · ISO 串 / `YYYY-MM-DD HH:mm:ss`（后者按 +08:00 语义）
 *   · 秒级数字（< 1e12，防御性兼容）
 * ⚠️ `Date.parse(String(1762732800000))` = NaN —— 直接喂字符串会把所有数字时间判成不可解析。
 */
function toMillis(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    return v < 1e12 ? v * 1000 : v;
  }
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    return n < 1e12 ? n * 1000 : n;
  }
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s)) {
    const iso = s.length === 16 ? `${s}:00` : s;
    const t = Date.parse(`${iso.replace(' ', 'T')}+08:00`);
    return Number.isNaN(t) ? null : t;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/**
 * 消息时间是否晚于 `end`（时间字段缺失/不可解析 → 保留，不误删）。
 *
 * ⚠️ 取值链必须与 `normalizeMessage` 一致：`at` → `createTime` → `create_time` → **`timestamp`**；
 *    且时间解析必须走 {@link toMillis}（数字毫秒 `createTime` 用 `Date.parse(String(x))` 会得 NaN
 *    → `isAfter` 恒 false → 客户端上界过滤失效 → end 之后的消息进返回体、水位被推到 end 之后 → 漏读）。
 */
function isAfter(msg, end) {
  const raw = msg?.at ?? msg?.createTime ?? msg?.create_time ?? msg?.timestamp;
  const t = toMillis(raw);
  const e = toMillis(end);
  if (t == null || e == null) return false;
  return t > e;
}

/**
 * @我 的消息（`chat +search-msg --at-me`）→ { messages, complete, stopReason }
 *
 * 收窄入参互斥：`senders`（按发送者 openId/userId）与 `chatId`（单个会话）**不能同时给**
 * —— dws 侧 `--senders` 与 `--chat-id` 互斥，hub 不替用户猜。
 *
 * @param {object} opts
 * @param {number} [opts.days=7] 搜索窗口（显式传入，不依赖 CLI 默认漂移）
 * @param {boolean} [opts.pageAll=true] 连续翻页
 * @param {string[]} [opts.senders] 发送者收窄 → `--senders a,b`
 * @param {string} [opts.chatId] 单会话收窄 → `--chat-id`
 * @param {string} [opts.bin] dws 可执行文件
 */
export async function atMe({ days = 7, pageAll = true, senders, chatId, bin } = {}) {
  if (chatId && Array.isArray(senders) && senders.length > 0) {
    badRequest('atMe：chatId 与 senders 互斥（只能给一个收窄条件）');
  }
  if (!Number.isInteger(days) || days < 1 || days > 30) {
    badRequest(`atMe：days 必须是 1..30 的整数（hub 策略上限），收到 ${days}`);
  }

  const args = ['chat', '+search-msg', '--at-me', '--days', String(days)];
  if (pageAll) args.push('--page-all');
  if (Array.isArray(senders) && senders.length > 0) args.push('--senders', senders.join(','));
  if (chatId) args.push('--chat-id', String(chatId));
  args.push('--format', 'json');

  const d = unwrapMapped(await dwsJson(args, { bin, timeoutMs: 180_000 }), 'chat +search-msg --at-me', {
    salvageKeys: ['messages'],
  });
  const stopReason = pickField(d, 'stopReason') ?? null;
  return {
    messages: pickArray(d, 'messages'),
    // 与 chatList / directMessages 同口径：打满页数（page_limit）等一律不算完整
    complete: pickComplete(d, { pageAll }) && !stopReasonIsError(stopReason),
    stopReason,
  };
}
