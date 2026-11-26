/**
 * 通用链接抽取（渠道无关、组织无关）
 *
 * 只做「从一段文本里认出像链接的东西」，不认识的公司/工单系统也能用：
 *   - 代码平台 MR/PR：`…/-/merge_requests/<iid>`、`…/-/pull/<n>`
 *   - 通用 issue：`…/issues/<id>`
 *
 * 不做域名白名单：调用方若需要收窄，自己过滤 `host`。
 */

const TRAIL = /[)\]}>,，。；;！!？?"'’”]+$/;

/** 去掉句末标点，避免把 `）` 吃进 URL。 */
function trimUrl(raw) {
  return String(raw || '').trim().replace(TRAIL, '');
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/**
 * 抽取 MR/PR 链接。
 * @returns {Array<{url:string, host:string, repo:string, iid:string, kind:'mr'|'pr'}>}
 */
export function extractMrUrls(text) {
  const out = [];
  const re = /https?:\/\/[^\s<>"']+?\/-\/(?:merge_requests|pull)\/(\d+)/g;
  for (const m of String(text || '').matchAll(re)) {
    const url = trimUrl(m[0]);
    const kind = url.includes('/pull/') ? 'pr' : 'mr';
    const repo = url.replace(/^https?:\/\/[^/]+\//, '').replace(/\/-\/(?:merge_requests|pull)\/\d+.*$/, '');
    out.push({ url, host: hostOf(url), repo, iid: m[1], kind });
  }
  return out;
}

/**
 * 抽取 issue 链接。
 * @returns {Array<{url:string, host:string, repo:string, id:string}>}
 */
export function extractIssueUrls(text) {
  const out = [];
  const re = /https?:\/\/[^\s<>"']+?\/issues\/(\d+)/g;
  for (const m of String(text || '').matchAll(re)) {
    const url = trimUrl(m[0]);
    const repo = url.replace(/^https?:\/\/[^/]+\//, '').replace(/\/issues\/\d+.*$/, '');
    out.push({ url, host: hostOf(url), repo, id: m[1] });
  }
  return out;
}

/** 主题 key：`mr:<repo>!<iid>` / `issue:<repo>#<id>`（repo 为空时退回 host）。 */
export function mrKeyOf(x) {
  return `mr:${x.repo || x.host}!${x.iid}`;
}

export function issueKeyOf(x) {
  return `issue:${x.repo || x.host}#${x.id}`;
}
