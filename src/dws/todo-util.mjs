/**
 * dws-hub · todo 纯工具（cli.runTodo 与单测共用）
 *
 * 为什么单独抽出来：
 *  1. `dws todo +get-related-tasks` 与 `+search` 返回字段不一致（`tasks` vs `todos`、`planFinishDate` vs `dueTime`），
 *     且日期既可能是 **ms 数值** 也可能是 **ISO / 日期字符串**；
 *     原实现 `new Date(Number(v)).toISOString()` 遇到字符串 → Invalid Date → **RangeError 直接崩**。
 *  2. 创建前去重必须只看**未完成**待办，否则上周已完成的同名待办会让周期性待办永远建不出来。
 */

/** 任意时间表示 → ISO 字符串；无法解析返回 null（**绝不抛**）。 */
export function toIso(v) {
  if (v === null || v === undefined || v === '') return null;
  let d;
  if (typeof v === 'number') {
    // 10 位按秒、13 位按毫秒
    d = new Date(v < 1e11 ? v * 1000 : v);
  } else if (/^\d{10,13}$/.test(String(v).trim())) {
    const n = Number(v);
    d = new Date(n < 1e11 ? n * 1000 : n);
  } else {
    d = new Date(String(v));
  }
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** 待办是否已完成（兼容 done / finished / finalStatusStage≥2 三种返回形态）。 */
export function isDone(t) {
  if (!t || typeof t !== 'object') return false;
  return t.done === true || t.finished === true || Number(t.finalStatusStage) >= 2;
}

/** 标题比对用的前缀长度（模糊搜/去重共用，防「长标题包含短标题」误判）。 */
export const TITLE_KEY_LEN = 20;

/** 在待办列表里找**未完成**的同标题待办；找不到返回 null。 */
export function findDuplicate(todos, title) {
  const needle = String(title || '').slice(0, TITLE_KEY_LEN).trim();
  if (!needle) return null;
  return (todos || []).find((t) => {
    if (!t || typeof t !== 'object' || isDone(t)) return false;
    return String(t.subject ?? t.title ?? '').includes(needle);
  }) || null;
}
