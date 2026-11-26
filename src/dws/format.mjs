/**
 * format.mjs —— 通知正文的**格式构造 + 校验**
 *
 * 一条通知 = 「@ 一个（或多个）人 + 一句话概要 + 一组链接」；链接可多条，逐行罗列。
 *
 * 群聊（默认）：
 *   <@openDingTalkId> {修改概要（≤15 字）}
 *   {MR 链接 1}
 *   {MR 链接 2}          ← 一批相关 MR 合并成一条通知，逐行罗列
 *
 * 单聊（dm=true）：第 1 行只放概要，**不生成 <@id> 占位符**
 *   —— 单聊没有「群成员 @」概念，占位符会原样显示成 `<@openId…>`（2026-10-10 实测踩坑）。
 *
 * 字数一律按**字符**（`[...str].length`，locale 无关）——`${#VAR}` / `wc -m` 在 LC_ALL=C 下按字节算会误判。
 *
 * 用法：
 *   import { buildNotifyBody, validateNotifyBody } from './format.mjs';
 *   const body = buildNotifyBody({ mentionId, summary, urls });            // 不合规抛错
 *   const { ok, errors } = validateNotifyBody(body, { mentionId });
 *   bun src/dws/format.mjs --mention-id <id> --summary "…" --url <u> [--url …]
 *   bun src/dws/format.mjs --body "<整段正文>" [--mention-id <id>] [--dm]
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MAX_SUMMARY_CHARS = 15;

/** 客套语：通知要「直接说改了什么」，不写寒暄（2026-09-23 用户定稿） */
export const PLEASANTRIES = ['帮忙', '辛苦', '麻烦', 'review', '看看', '请', 'thanks', 'pls', '有空'];

const AT_RE = /^<@([A-Za-z0-9]+)>\s*(.*)$/;
const URL_RE = /^https?:\/\/\S+$/;
const MR_URL_RE = /^https?:\/\/\S+\/-\/(?:merge_requests|pull)\/\d+$/;

/** 字符数（locale / 编码无关） */
export function charLen(s) {
  return [...String(s ?? '')].length;
}

function checkSummary(summary, errors) {
  if (!summary) {
    errors.push('缺少修改概要（@ 后面必须有内容）');
    return;
  }
  const n = charLen(summary);
  if (n > MAX_SUMMARY_CHARS) {
    errors.push(`修改概要 ${n} 字 > ${MAX_SUMMARY_CHARS} 字：「${summary}」——先精简再发`);
  }
  const hit = PLEASANTRIES.filter((w) => summary.includes(w));
  if (hit.length) {
    errors.push(`修改概要含客套语 ${hit.join('/')}：「${summary}」——直接说改了什么`);
  }
  if (summary.includes('\n')) errors.push('修改概要不能换行');
}

function checkUrl(url, errors, warnings, lineno) {
  const where = lineno ? `第 ${lineno} 行` : '链接所在行';
  if (!URL_RE.test(url)) {
    errors.push(`${where}必须是**独占一行的纯 URL**（无其他文字、无空格）：${JSON.stringify(url)}`);
    return;
  }
  if (!MR_URL_RE.test(url)) {
    warnings.push(`链接不像 MR/PR 链接（期望 .../-/merge_requests/<iid> 或 .../-/pull/<n>）：${url}`);
  }
}

/**
 * 计算通知正文与校验结果（纯函数，不抛错）。
 * @param {{reviewerId?: string, summary: string, urls?: string[], dm?: boolean}} opts
 * @returns {{ok: boolean, body: string|null, errors: string[], warnings: string[]}}
 */
export function checkNotify({ reviewerId, summary, urls = [], dm = false }) {
  const errors = [];
  const warnings = [];
  checkSummary(summary, errors);
  for (const u of urls) checkUrl(u, errors, warnings);
  if (!dm && !reviewerId) errors.push('缺少 reviewerId（@ 对象 openDingTalkId）');
  if (dm && reviewerId) errors.push('单聊模式（dm）不生成 @ 占位符，不应传 reviewerId');
  if (!urls.length) errors.push('至少需要一个 url（MR 链接）');

  const body = dm ? [summary, ...urls].join('\n') : [`<@${reviewerId}> ${summary}`, ...urls].join('\n');
  return { ok: errors.length === 0, body: errors.length ? null : body, errors, warnings };
}

/**
 * 构造通知正文（不合规抛错，错误信息即人话）。
 * @param {{reviewerId?: string, summary: string, urls?: string[], dm?: boolean, onWarning?: (w: string) => void}} opts
 */
export function buildNotifyBody(opts) {
  const r = checkNotify(opts);
  if (!r.ok) {
    const e = new Error(`通知格式不合规：\n- ${r.errors.join('\n- ')}`);
    e.errors = r.errors;
    e.warnings = r.warnings;
    throw e;
  }
  if (r.warnings.length && typeof opts.onWarning === 'function') {
    for (const w of r.warnings) opts.onWarning(w);
  }
  return r.body;
}

/**
 * 校验已有正文。
 * @param {string} body
 * @param {{reviewerId?: string, dm?: boolean}} opts
 * @returns {{ok: boolean, errors: string[], warnings: string[]}}
 */
export function validateNotifyBody(body, { reviewerId, dm = false } = {}) {
  const errors = [];
  const warnings = [];
  const lines = String(body ?? '').replace(/\n+$/, '').split('\n');

  if (lines.length < 2) {
    errors.push(
      `正文至少 2 行（第 1 行 ${dm ? '概要' : '@+概要'} / 其后每行一条链接），实际 ${lines.length} 行`,
    );
    return { ok: false, errors, warnings };
  }
  if (lines.some((ln) => ln.trim() === '')) {
    errors.push('正文不能含空行（空行会破坏钉钉渲染）——一批多链接直接逐行罗列即可');
    return { ok: false, errors, warnings };
  }

  const first = lines[0];
  const m = AT_RE.exec(first);
  if (dm) {
    if (m) {
      errors.push(`单聊正文不应含 <@id> 占位符（单聊无「群成员 @」，会原样显示）：${JSON.stringify(first.slice(0, 60))}`);
      checkSummary(m[2].trim(), errors);
    } else {
      checkSummary(first.trim(), errors);
    }
  } else if (!m) {
    errors.push(`第 1 行必须以 <@openDingTalkId> 开头（@ 在最前）：${JSON.stringify(first.slice(0, 60))}`);
  } else {
    const [, atId, summary] = m;
    if (reviewerId && atId !== reviewerId) {
      errors.push(`@ 占位符 ID (${atId}) 与 reviewerId (${reviewerId}) 不一致`);
    }
    checkSummary(summary.trim(), errors);
  }

  lines.slice(1).forEach((ln, i) => checkUrl(ln.trim(), errors, warnings, i + 2));
  return { ok: errors.length === 0, errors, warnings };
}

// ── CLI ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { urls: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--reviewer-id') out.reviewerId = argv[++i];
    else if (a === '--summary') out.summary = argv[++i];
    else if (a === '--url') out.urls.push(argv[++i]);
    else if (a === '--body') out.body = argv[++i];
    else if (a === '--dm') out.dm = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function cli() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`用法：
  node format.mjs --reviewer-id <id> --summary "≤15 字" --url <u> [--url …]   # 构造（正文 → stdout）
  node format.mjs --dm --summary "≤15 字" --url <u>                            # 单聊构造（无 <@id>）
  node format.mjs --body "<整段正文>" [--reviewer-id <id>] [--dm]              # 只校验
退出码：0 通过 / 1 不合规 / 2 用法错误`);
    return 0;
  }
  try {
    if (args.body !== undefined) {
      const r = validateNotifyBody(args.body, { reviewerId: args.reviewerId, dm: args.dm });
      for (const w of r.warnings) console.error(`  ⚠️  ${w}`);
      if (!r.ok) {
        for (const e of r.errors) console.error(`  ❌ ${e}`);
        console.error('\n❌ 自检不通过——修好再发（格式不对 = 不发送）');
        return 1;
      }
      console.log(args.body);
      return 0;
    }
    if (!args.summary || !args.urls.length || (!args.reviewerId && !args.dm)) {
      console.error('❌ 构造模式需要 --reviewer-id / --summary / --url（可多条；或改用 --body）');
      return 2;
    }
    const body = buildNotifyBody({
      reviewerId: args.reviewerId,
      summary: args.summary,
      urls: args.urls,
      dm: args.dm,
    });
    for (const w of body.warnings ?? []) console.error(`  ⚠️  ${w}`);
    console.error('  ✓ 自检通过，BODY 已输出到 stdout');
    console.log(body);
    return 0;
  } catch (err) {
    for (const w of err.warnings ?? []) console.error(`  ⚠️  ${w}`);
    for (const e of err.errors ?? [err.message]) console.error(`  ❌ ${e}`);
    console.error('\n❌ 自检不通过——修好再发（格式不对 = 不发送）');
    return 1;
  }
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return fileURLToPath(import.meta.url) === process.argv[1];
  }
}

if (isDirectRun()) {
  process.exit(cli());
}
