/**
 * dws-hub · hub 层 —— `consumers add --targets` 白名单（docs/design.md）
 *
 * 设计：docs/design.md
 *
 * 为什么要有白名单：targets 决定「流怎么收窄、轮询拉什么」，拼错的形态（`atme` 裸写、
 * `chat:<cid>`）会让 `scopesOf()` 把歧义当成具体 scope 去轮询 → `bad_scope` / 静默 0 事件。
 * 宁可在**写入前**以参数错误（hub code 2）拒掉，也不落库一个「看起来订阅了其实收不到」的消费者。
 *
 * 合法形态：
 *   self / group:<cid> / direct:<uid> / atme:* / atme:chat:<cid> / atme:user:<uid>
 *   group:* / direct:* / *（通配：只做分派，不参与具体轮询，见 `scopesOf`）
 * 非法形态：`atme`（歧义：全量还是收窄？）/ `chat:<cid>`（旧稿写法）/ 空项。
 */

/** 白名单正则（`<cid>` / `<uid>` 必须非空）。 */
const TARGET_RULES = [
  /^\*$/,                       // 分派通配
  /^self$/,                     // 自聊
  /^group:(\*|.+)$/,            // 群会话 <cid> / group:*
  /^direct:(\*|.+)$/,           // 单聊对方 <uid> / direct:*
  /^atme:\*$/,                  // 全量 @我
  /^atme:chat:.+$/,             // @我 + 会话收窄（按会话 id 过滤）
  /^atme:user:.+$/,             // @我 + 发送者收窄（按发送者 id 过滤）
];

/** 参数错误（hub 契约码 2：确定性错误，不可重试）。 */
function invalidTarget(msg) {
  const err = new Error(msg);
  err.code = 2;
  err.retryable = false;
  return err;
}

/** 该项是否是合法 target（单项、已 trim）。 */
export function isValidTarget(target) {
  return typeof target === 'string' && TARGET_RULES.some((re) => re.test(target));
}

/**
 * 校验并归一化 targets（空值/非法项 → 抛 code 2 参数错误，调用方据此拒绝写库）。
 *
 * @param {string[]} list 原始 target 列表（CLI 已按 `,` 拆分）
 * @returns {string[]} 归一化后的同序列表（仅 trim，不改写形态）
 */
export function parseTargets(list) {
  if (!Array.isArray(list)) throw invalidTarget('targets 必须是数组');
  const out = [];
  for (const raw of list) {
    const t = typeof raw === 'string' ? raw.trim() : '';
    if (!t) throw invalidTarget('targets 含空项（合法形态见消费者用法）');
    if (!isValidTarget(t)) {
      throw invalidTarget(
        `非法 target「${t}」：只接受 self / group:<cid> / direct:<uid> / atme:* / atme:chat:<cid> / atme:user:<uid> / group:* / direct:* / *（atme 裸写与 chat:<cid> 已作废）`,
      );
    }
    out.push(t);
  }
  return out;
}
