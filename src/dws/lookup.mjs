/**
 * lookup.mjs —— 钉钉「找人 / 考勤」查询（dws-hub L1 能力，2026-11-06）
 *
 * 覆盖 contact user search / contact +me / user get-self / attendance approve list。
 *
 * 只做「查询」：不缓存、不判定业务（缓存/请假判定留在调用方）。
 * 失败抛错（含 dws 原文），由调用方决定降级策略。
 */
import { dwsJson } from './dws.mjs';

function unwrap(r, what) {
  if (!r.ok) {
    const detail = (r.raw || '').slice(0, 300) || r.data?.error?.message || `exit ${r.code}`;
    const err = new Error(`${what} 失败：${detail}`);
    err.code = r.code;
    err.data = r.data;
    throw err;
  }
  return r.data;
}

/** 按姓名/工号/关键词找用户 → [{name, userId, openDingTalkId, ...}] */
export async function searchUsers(query, { bin } = {}) {
  const d = unwrap(
    await dwsJson(['contact', 'user', 'search', '--query', String(query), '--format', 'json'], { bin }),
    'contact user search',
  );
  return d.result || d.users || d.data?.users || d.data?.result || [];
}

/** 当前登录用户 → {name, userId, openDingTalkId, ...} */
export async function selfUser({ bin } = {}) {
  const d = unwrap(await dwsJson(['contact', '+me', '--format', 'json'], { bin }), 'contact +me');
  return d.data || d.result || d;
}

/** 请假审批单（指定日期）→ 记录数组（空数组 = 未请假） */
export async function leaveRecords({ userIds, date, bin } = {}) {
  const ids = (Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean).join(',');
  if (!ids) return [];
  const d = unwrap(
    await dwsJson(
      ['attendance', 'approve', 'list', '--users', ids, '--types', 'leave', '--start', String(date), '--end', String(date), '--format', 'json'],
      { bin },
    ),
    'attendance approve list',
  );
  return d.result || d.data?.result || d.records || [];
}
