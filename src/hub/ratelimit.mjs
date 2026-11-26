/**
 * dws-hub · hub 层（渠道无关）—— 限频闸
 *
 * 设计：docs/design.md（频率与限流）
 * 默认额度（可覆盖）：DING 2/日、单聊 6/时·20/日、静默 20:00–09:00。
 *
 * 语义：**闸只回答「能不能发」**；发不出去时的降级（DING→待办→日历→消息）由 notify 决定并留痕。
 */
const TZ_OFFSET_H = Number(process.env.DWS_HUB_TZ_OFFSET_H ?? 8);

export const DEFAULT_RULES = {
  /** 强提醒（DING）：额度最紧，且有静默时段。 */
  strong_push: { perDay: 2, quiet: [20, 9] },
  /** 电话 DING：只给「线上故障」级，**无静默时段**但额度更紧（有通信费）。 */
  call: { perHour: 1, perDay: 2 },
  /** 普通消息（自聊/私聊）。 */
  message: { perHour: 6, perDay: 20 },
  /** 轻互动（表情等）。 */
  interact: { perHour: 30 },
  /** 降级通道（自建待办）—— 防降级后刷屏。 */
  todo: { perDay: 5 },
  /** 降级通道（日程）。 */
  calendar: { perDay: 5 },
};

function localParts(now) {
  const d = new Date(now + TZ_OFFSET_H * 3600e3);
  return {
    day: d.toISOString().slice(0, 10),
    hour: d.toISOString().slice(0, 13),
    hourOfDay: d.getUTCHours(),
  };
}

export function inQuietHours(now, [from, to]) {
  const h = localParts(now).hourOfDay;
  return from <= to ? (h >= from && h < to) : (h >= from || h < to);
}

/**
 * 是否允许发送。
 * @returns {{ok: boolean, reason?: string, used?: object}} `reason`: quiet_hours | per_hour | per_day
 */
export function allow(store, kind, { now = Date.now(), rules = DEFAULT_RULES, force = false } = {}) {
  const rule = rules[kind];
  if (!rule) return { ok: true, used: {} };
  const { day, hour } = localParts(now);
  const ns = `ratelimit:${kind}`;
  if (!force && rule.quiet && inQuietHours(now, rule.quiet)) {
    return { ok: false, reason: 'quiet_hours', used: { hour: store.kv.get(ns, hour, 0), day: store.kv.get(ns, day, 0) } };
  }
  const used = { hour: Number(store.kv.get(ns, hour, 0)) || 0, day: Number(store.kv.get(ns, day, 0)) || 0 };
  if (rule.perHour && used.hour >= rule.perHour) return { ok: false, reason: 'per_hour', used };
  if (rule.perDay && used.day >= rule.perDay) return { ok: false, reason: 'per_day', used };
  return { ok: true, used };
}

/** 记账（发送成功后调用）。 */
export function charge(store, kind, { now = Date.now() } = {}) {
  const { day, hour } = localParts(now);
  const ns = `ratelimit:${kind}`;
  store.kv.bump(ns, hour, 1);
  store.kv.bump(ns, day, 1);
  return { hour: Number(store.kv.get(ns, hour, 0)), day: Number(store.kv.get(ns, day, 0)) };
}

/** 当前用量快照（health 用）。 */
export function usage(store, { now = Date.now() } = {}) {
  const { day, hour } = localParts(now);
  const out = {};
  for (const kind of Object.keys(DEFAULT_RULES)) {
    const ns = `ratelimit:${kind}`;
    out[kind] = {
      hour: Number(store.kv.get(ns, hour, 0)) || 0,
      day: Number(store.kv.get(ns, day, 0)) || 0,
      rule: DEFAULT_RULES[kind],
    };
  }
  return out;
}
