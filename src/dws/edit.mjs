/**
 * edit.mjs —— 消息纠正（编辑原消息；2026-11-13 用户指令）
 *
 * 原则：已发出的钉钉消息内容/格式/@ 渲染有错时，**只编辑那条消息**——
 * 不撤回重发、不发「更正：…」新消息（避免刷屏、断引用链、丢上下文）。
 *
 * ══ 已知坑（实证，勿踩）══
 * 1. 正文**不要写 `<@id>` 占位符**：引用消息（reply）的 @ 由接口按引用自动带；
 *    写了会**原样落库**（群里显示成一串 ID，看起来像乱码）。
 * 2. 编辑**幂等**：同一 messageId 重复编辑只是覆盖正文，重试安全；但**不要**用「撤回 + 重发」兜底（会断链）。
 * 3. 编辑后**必须读回**（`chat message list-by-ids`）断言无 `<@` 字面量且正文完整——
 *    dws 的编辑回执只给 editStatus，不给正文。
 */
import { dwsJson } from './dws.mjs';

/** 字面量 @ 占位符（`<@openId…>`）——编辑正文里出现即视为「会落库的脏数据」 */
const LITERAL_AT_RE = /<@[A-Za-z0-9+/=_-]+>/;

/** 诊断双通道用：先 export 供测试/调用方断言 */
export function findLiteralMentions(text) {
  const hits = [];
  const re = new RegExp(LITERAL_AT_RE.source, 'g');
  let m;
  while ((m = re.exec(String(text ?? '')))) hits.push(m[0]);
  return hits;
}

function fail(msg) {
  const e = new Error(msg);
  e.usage = true;
  throw e;
}

/**
 * 构造 Markdown content JSON（dws `--content` 的形状）。
 * 不传 title 时**不塞空 title**（避免编辑后变成带标题的卡片样式）。
 */
export function buildEditContent(text, { title } = {}) {
  const content = { text: String(text ?? '') };
  if (title) content.title = String(title);
  return JSON.stringify(content);
}

/** 构造 `dws chat message edit` argv（dry-run 与真发共用，防「回显 ≠ 实发」）。 */
export function buildEditArgs(conv, msgId, text, { title } = {}) {
  if (!conv) fail('edit：缺少 --conversation-id（群/单聊的 openConversationId）');
  if (!msgId) fail('edit：缺少 --message-id（要纠正的那条消息 openMessageId）');
  const body = String(text ?? '');
  if (!body.trim()) fail('edit：正文不能为空（清空消息请走撤回，不要用编辑）');
  const literals = findLiteralMentions(body);
  if (literals.length) {
    fail(`正文含字面量占位符 ${literals.join('、')}：引用消息的 @ 由接口自动带，写了会原样落库（群里显示像乱码）。去掉后重试`);
  }
  return [
    'chat', 'message', 'edit',
    '--conversation-id', String(conv),
    '--message-id', String(msgId),
    '--content', buildEditContent(body, { title }),
    '--yes', '--format', 'json',
  ];
}

/** 执行编辑；返回 dwsJson 信封 `{ok, data, raw, code, parsed}`。 */
export async function editMessage(conv, msgId, text, { bin, title } = {}) {
  const args = buildEditArgs(conv, msgId, text, { title });
  return dwsJson(args, { bin });
}

/** 把 dws 的 `content` 归一成正文：markdown 消息是 JSON 串（`{title,text}`），普通消息是纯文本。 */
export function contentToText(content) {
  const raw = String(content ?? '');
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && typeof v.text === 'string') return v.text;
  } catch {
    /* 纯文本消息：JSON.parse 失败即原样返回 */
  }
  return raw;
}

/** 按消息 id 读回（编辑校验的权威读数）。 */
export async function readMessage(msgId, { bin } = {}) {
  const r = await dwsJson(['chat', 'message', 'list-by-ids', '--msg-ids', String(msgId), '--format', 'json'], { bin });
  const d = (r && r.data) || {};
  const msg = d?.result?.messages?.[0] || d?.data?.messages?.[0] || d?.messages?.[0] || null;
  const content = msg?.content ?? '';
  return {
    ok: Boolean(msg),
    found: Boolean(msg),
    messageId: msg?.messageId || msg?.openMessageId || null,
    content: String(content),
    text: contentToText(content),
    hasLiteralMention: findLiteralMentions(content).length > 0,
    raw: r?.raw ?? null,
  };
}

/**
 * 编辑 + 读回校验（推荐入口）。
 * @returns {{ok:boolean, edit:object, verify:object}} ok = 编辑成功 **且** 读回无字面量
 */
export async function editAndVerify(conv, msgId, text, { bin, title } = {}) {
  const edit = await editMessage(conv, msgId, text, { bin, title });
  if (!edit?.ok) return { ok: false, edit, verify: null };
  const verify = await readMessage(msgId, { bin });
  return { ok: verify.ok && !verify.hasLiteralMention, edit, verify };
}
