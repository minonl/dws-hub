/**
 * `dws-hub doctor` —— 环境自检（只读）
 *
 * 目的：把「看起来在跑其实没投递」「注册路径指向旧安装」这类静默故障提前暴露。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { dataRoot, dbPath, ENV, followsPath } from './config.mjs';
import { RUN_ENTRY, status as serviceStatus } from './service/install.mjs';

function probe(bin, args) {
  try {
    const out = execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
    return { ok: true, out: out.trim().split('\n')[0] };
  } catch (e) {
    return { ok: false, error: String(e?.stderr || e?.message || e).trim().slice(0, 300) };
  }
}

export function doctor({ env = process.env } = {}) {
  const checks = [];
  const add = (id, ok, detail, fix) => checks.push({ id, ok, detail, ...(ok ? {} : { fix }) });

  // 1) bun
  const bun = globalThis.Bun?.version;
  add('bun', Boolean(bun), bun ? `bun ${bun}` : '不在 bun 运行时下（bin 需要 bun）', '安装 bun：https://bun.sh');

  // 2) dws
  const dws = probe(env.DWS_BIN || 'dws', ['--version']);
  add('dws', dws.ok, dws.ok ? dws.out : `不可执行：${dws.error}`, '安装 dws 并确保在 PATH（注意 dws 是 Node 脚本，需要 node）');

  // 3) dws 登录态
  try {
    const auth = execFileSync(env.DWS_BIN || 'dws', ['auth', 'status'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
    const authed = /authenticated|已登录|logged/i.test(auth) && !/not\s+logged|未登录/i.test(auth);
    add('auth', authed, authed ? '已登录' : auth.trim().slice(0, 120), 'dws auth login --device');
  } catch (e) {
    add('auth', false, `auth status 失败：${String(e?.stderr || e?.message).slice(0, 120)}`, 'dws auth login --device');
  }

  // 4) 数据根
  const root = dataRoot(env);
  const tmpPrefixes = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders', tmpdir()].filter(Boolean);
  const ephemeral = tmpPrefixes.some((p) => root.startsWith(p.replace(/\/$/, '')));
  add('data-root', !ephemeral, root, '把 DWS_HUB_HOME 指到持久目录（系统临时目录重启即丢）');

  // 5) 库（不存在是正常状态：首次运行会创建）
  const db = dbPath(env);
  add('db', true, existsSync(db) ? `${db}（${Math.round(statSync(db).size / 1024)} KB）` : `${db} 尚未创建（首次运行会创建）`);

  // 6) 投递命令
  const cmd = String(env[ENV.inboxCmd] || '').trim();
  add('inbox', Boolean(cmd), cmd ? 'DWS_HUB_INBOX_CMD 已配置' : '未配置：消息只落 logs/inbox-skipped-*.jsonl', `设置 ${ENV.inboxCmd}（模板变量见 README）`);

  // 7) 订阅注册表
  const follows = followsPath(env);
  add('follows', true, existsSync(follows) ? `${follows}` : `${follows} 不存在（无订阅）`);

  // 8) 服务
  const svc = serviceStatus();
  const entryDrift = svc.entry !== RUN_ENTRY;
  if (svc.platform === 'launchd') {
    add('service', svc.loaded && !entryDrift, `launchd ${svc.label} loaded=${svc.loaded}${entryDrift ? `；注册入口=${svc.entry} ≠ 当前=${RUN_ENTRY}` : ''}`, entryDrift ? 'dws-hub service install' : 'dws-hub service install');
  } else {
    add('service', svc.active === 'active', `systemd ${svc.label} active=${svc.active || 'unknown'}`, 'dws-hub service install');
  }

  const ok = checks.every((c) => c.ok);
  return { ok, data_root: root, checks };
}
