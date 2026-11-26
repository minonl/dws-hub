/**
 * ding.mjs —— 钉钉强提醒（DING）（dws-hub L1 能力，2026-11-06）
 *
 * 统一封装 DING 调用：额度、静默时段、幂等键、降级由本包负责，调用方只给「发给谁 + 内容」。
 *
 * ⚠️ 实测（2026-11-06 `dws ding +send-personal --help`）：
 *   · 接收人是 **openDingTalkId**（`--users`），不是 userId；
 *   · 正文参数是 **`--content`**（必填），**没有 `--text`**（旧调用传 `--text` 会参数错误）；
 *   · 支持 `--uuid` 幂等键（重发安全）。
 *
 * 设计：docs/design.md/docs/design.md
 *   · `buildDingArgs()` 是 argv 的**唯一**来源（真发与 `--dry-run` 回显共用同一份）；
 *   · `--type` **可选追加**，且 `app`（含缺省）**不写**该 flag（未实测前不改动既有调用方 argv）；
 *   · `--allow-cost` 属 CLI 侧成本闸，**不进 dws argv**。
 */
import { dwsJson } from './dws.mjs';

/**
 * DING argv 构造（顺序固定，`--format json` 恒在末尾）：
 *
 *   ding +send-personal --users <to> --content <text> [--uuid <k>] [--type <t>] --format json
 *
 * `type` 为 `app` 或缺省 → **不追加** `--type`（`app` 无需任何 flag）。
 */
export function buildDingArgs({ to, text, uuid, type } = {}) {
  if (!to) throw new Error('buildDingArgs：缺少 to');
  if (!text) throw new Error('buildDingArgs：缺少 text');
  const args = ['ding', '+send-personal', '--users', String(to), '--content', String(text)];
  if (uuid) args.push('--uuid', String(uuid));
  const t = type === undefined || type === null ? 'app' : String(type);
  if (t !== 'app') args.push('--type', t);
  args.push('--format', 'json');
  return args;
}

/**
 * 给指定 openDingTalkId 发 DING。
 *
 * 成功判定（docs/design.md）：**只看 dws 退出码**（`dwsJson` 的 `ok`），
 * ⚠️ **不再**对 `raw` 做 `"success":true` / `"ok":true` 正则判定——
 *    partial 结果（`{"success":false,"data":[{"success":true}]}`）与错误信封回显的正文
 *    都会命中该正则，把「实际失败」翻成 `ok:true`（调用方以为已送达 → 静默假绿）。
 *
 * @returns {Promise<{ok: boolean, raw: string, data: object, code: number|null, dry_run?: true, argv?: string[]}>}
 */
export async function sendPersonalDing({ openDingTalkId, text, uuid, type, bin, dryRun = false } = {}) {
  if (!openDingTalkId) throw new Error('sendPersonalDing：缺少 openDingTalkId');
  if (!text) throw new Error('sendPersonalDing：缺少 text');
  const args = buildDingArgs({ to: openDingTalkId, text, uuid, type });
  // dry-run：**在 dwsJson 之前**返回（零出网、零台账、零配额），与 send.mjs 同一姿势
  if (dryRun) return { ok: true, dry_run: true, argv: args };
  const r = await dwsJson(args, { bin, timeoutMs: 60_000 });
  // `code` 透传 dws 子进程退出码（CLI 失败信封的 detail.dwsCode；spawn/超时 → null）
  return { ok: r.ok, raw: r.raw || '', data: r.data, code: r.code ?? null };
}
