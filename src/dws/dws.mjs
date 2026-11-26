/**
 * dws-hub · dws 适配层 —— dws CLI 调用基础
 *
 * 设计：docs/design.md（外部契约）
 *
 * ══ 已知坑（实证，勿踩）══
 * 1. `dws` 在 partial_success / 业务错误时把 JSON 写到 **stderr**（stdout 为空）→ 解析需回退 stderr。
 * 2. `calendar +create` 会因**读回校验**误报 failure（`readback_field_missing: timeZone`），
 *    但事件**实际已创建** → 必须复核（`+agenda`），**禁止盲重试**（会重复建日程）。
 * 3. `todo +reminder` 上游**无提醒读接口**（结果恒 `verified: false`）→ 只能终端回执 + 人工观察。
 * 4. `--duration 0` 无限期监听 = doctor 明令禁止项（野生进程）→ 一律**有界**（见 listen.mjs）。
 * 5. `exit 0` 但输出不是 JSON（如 stdout 只有进度行 `paging 3/20 ...`）**不是成功**：
 *    `dwsJson` 返回 `ok:false` + `parsed:false`（`data._raw`）→ 读类调用方必须按上游失败处理，
 *    否则「解析失败」会被伪装成「读到了空结果」（假成功 → 水位推进 → 漏读）。
 */
import { spawn } from 'node:child_process';

/** dws 可执行文件（cron/launchd 环境 PATH 极简 → 允许显式注入）。 */
export function dwsBin() {
  return process.env.DWS_BIN || 'dws';
}

/**
 * dws 响应信封的「强特征键」。
 *
 * 逐行兜底**只认这些键**：dws 可能在 JSON 前打进度行（`paging 3/20 ...`），
 * 但 stderr 里也常有**日志行 / NDJSON 分页行**（`{"level":"info","msg":"page done"}`、
 * `{"page":3,"total":20}`）。若把任意对象形状的单行 JSON 当整份 payload，
 * 就会把噪声伪装成「读到了空结果」（`{messages: [], complete: true}`）→ 假成功 → 漏读。
 */
const PAYLOAD_KEYS = [
  'messages', 'conversations', 'chats', 'data', 'result', 'ok', 'success', 'outcome',
  'error', 'authenticated', 'token_valid', 'users', 'records', 'tasks', 'files', 'events',
  'agenda', 'calendar', 'todos', 'contacts', 'content',
  'openDingId', 'openTaskId', 'messageId', 'eventId', 'taskId', 'userId', 'conversationId',
];

/** 日志行特征（`{"level":"info","msg":"page done"}` 之类）——**永远不是**业务信封。 */
function looksLikeLogRecord(v) {
  const hasLevel = typeof v.level === 'string' || typeof v.logLevel === 'string' || typeof v.severity === 'string';
  if (!hasLevel) return false;
  return 'msg' in v || 'message' in v || 'err' in v || 'error' in v
    || 'time' in v || 'ts' in v || 'timestamp' in v || 'caller' in v;
}

/** 是否是「可能的 dws 业务信封」（排除日志行 / NDJSON 分页进度行）。 */
function looksLikePayload(v) {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  if (looksLikeLogRecord(v)) return false;
  return Object.keys(v).some((k) => PAYLOAD_KEYS.includes(k));
}

/**
 * 解析 dws 输出：整段 JSON 优先（stdout → stderr，坑 1），
 * 整段不可解析时**逐行倒序**兜底（dws 可能在 JSON 之前打进度行 `paging 3/20 ...`）。
 *
 * ⚠️ 逐行兜底**必须**再判「像不像业务信封」（见 `looksLikePayload`）：
 *    否则日志行 `{"level":"info","msg":"page done"}` 会被当整份 payload → 假成功。
 *
 * @returns {{data:object, raw:string, parsed:boolean}} parsed=false 时 data 只有 `_raw` 噪声
 */
function parseDwsOutput(out, err) {
  const sources = [String(out || ''), String(err || '')].filter((s) => s.trim());
  // 整段解析：必须是业务信封形状（日志行 / 分页进度行即使独占一行也不算，见 looksLikePayload）
  for (const s of sources) {
    try {
      const v = JSON.parse(s.trim());
      if (looksLikePayload(v)) return { data: v, raw: s.trim(), parsed: true };
    } catch { /* 试下一种 */ }
  }
  // 逐行兜底：只接受业务信封形状，日志行 / NDJSON 分页行一律不算
  for (const s of sources) {
    const lines = s.split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const v = JSON.parse(line);
        if (looksLikePayload(v)) return { data: v, raw: s.trim(), parsed: true };
      } catch { /* 继续往上找 */ }
    }
  }
  const noise = (out && String(out).trim()) || (err && String(err).trim()) || '';
  return { data: { _raw: noise.slice(0, 400) }, raw: noise, parsed: false };
}

/** 信封是否带**非空** `error`（成功响应不会带）。 */
function hasErrorEnvelope(data) {
  const e = data?.error;
  if (e == null) return false;
  if (typeof e === 'string') return e.trim() !== '';
  if (Array.isArray(e)) return e.length > 0;
  return typeof e === 'object' && Object.keys(e).length > 0;
}

/**
 * 执行一次 dws 调用并解析 JSON（stdout 优先，失败回退 stderr —— 坑 1）。
 *
 * ⚠️ **解析失败不算成功**（2026-11-10 修）：dws 退出码 0 但输出读不懂（典型 stdout 只有
 *    进度行 `paging 3/20 ...`）时，`ok` 必须为 `false`。否则读类调用方会把
 *    「输出解析失败」当「读到了空结果」→ 推进水位 → 整窗消息永久漏读。
 *
 * @returns {Promise<{ok:boolean, data:object, raw:string, code:number|null, parsed:boolean}>}
 */
export function dwsJson(args, { timeoutMs = 60_000, bin = dwsBin() } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { shell: false });
    let out = '', err = '', done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch { /* noop */ }
      resolve({ ok: false, data: { error: { type: 'timeout' } }, raw: out || err, code: null });
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      if (done) return; done = true; clearTimeout(timer);
      resolve({ ok: false, data: { error: { type: 'spawn_error', message: String(e?.message || e) } }, raw: '', code: null });
    });
    child.on('close', (code) => {
      if (done) return; done = true; clearTimeout(timer);
      const { data, raw, parsed } = parseDwsOutput(out, err);
      // parsed=false ⇒ 一律失败（退出码 0 也不行）；信封自报失败同样不算成功。
      // ⚠️ 非空 `error` 也是失败（docs/design.md 修正表：ok:false/success:false/outcome:failure/**非空 error**）。
      //    只判 ok/success/outcome 会让 `exit 0 + {error:{...}}` 漏成「读到了空结果」→ 假成功。
      const ok = code === 0 && parsed
        && !(data && (data.ok === false || data.success === false || data.outcome === 'failure'))
        && !hasErrorEnvelope(data);
      resolve({ ok, data, raw, code, parsed });
    });
  });
}

/**
 * 起一个**长连接**事件流（NDJSON 逐行回调）。用于 listen 的 stream 通道。
 * @param {(evt:object)=>void} onEvent 每行解析后回调
 * @returns {{kill:()=>void, done:Promise<{code:number|null, exited:string}>}}
 */
export function dwsStream(args, onEvent, { bin = dwsBin() } = {}) {
  const child = spawn(bin, args, { shell: false });
  let buf = '';
  const lifecycle = [];
  const handle = (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { onEvent(JSON.parse(line)); } catch { /* 非 JSON 行（生命周期文本）→ 忽略 */ }
    }
  };
  child.stdout.on('data', handle);
  child.stderr.on('data', (c) => { lifecycle.push(c.toString().trim()); });
  const done = new Promise((resolve) => {
    child.on('close', (code) => resolve({ code, exited: lifecycle.join('\n') }));
  });
  return { kill: () => { try { child.kill('SIGTERM'); } catch { /* noop */ } }, done, pid: child.pid };
}

/** 出站标记（docs/design.md）：让「AI 发的」与「我本人发的」可区分。 */
export function outboundMarker(consumer) {
  const tpl = process.env.DWS_HUB_MARKER || '🤖 dws-hub · {consumer}';
  return tpl.replace('{consumer}', consumer || 'hub');
}

/**
 * **机器消息模式**
 *
 * 本包只认自己的出站标记。若调用方还有别的服务也在发机器消息（自带文案、不带标记），
 * 用 `DWS_HUB_MACHINE_PATTERNS`（逗号分隔）追加——**不要把某家公司的文案写进本包**。
 */
export const MACHINE_PATTERNS = [
  '🤖 dws-hub',
];

/** 该文案是否**非人工**（机器/服务发出）—— 入站解析据此排除（防自我回环、防误当人的回复）。 */
export function isMachineText(text, { extra = [] } = {}) {
  const t = text || '';
  const pats = [...MACHINE_PATTERNS, ...extra];
  const envExtra = (process.env.DWS_HUB_MACHINE_PATTERNS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return [...pats, ...envExtra].some((p) => t.includes(p));
}

/** @deprecated 语义加强为「机器消息」判定，保留旧名以兼容调用方。 */
export function isOutboundText(text, consumer = null) {
  if (customerPrefixMatch(text, consumer)) return true;
  return isMachineText(text);
}

function customerPrefixMatch(text, consumer) {
  if (!consumer) return false;
  return (text || '').includes(outboundMarker(consumer));
}

/**
 * 是否**真发**（运行时判定，不固化为常量）。
 * ⚠️ 2026-10-16 实测教训：若写成模块级常量，**测试无法按用例切换**（同进程内改 env 无效），
 *    且「服务 dry-run 空跑」与「人工真发」的判定会僵死 → 改为函数，每次调用时读 env。
 */
export function isReal() {
  return process.env.DWS_HUB_ENABLE === '1';
}

/** @deprecated 用 {@link isReal}（常量在模块加载时固化，测试与运行时切换都会踩坑） */
export const REAL = process.env.DWS_HUB_ENABLE === '1';
