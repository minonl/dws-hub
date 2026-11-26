/**
 * 配置与环境变量（唯一事实源）
 *
 * 为什么单独一个文件：`hub/` 是渠道无关层，不允许出现渠道字样（有机检），
 * 所以环境变量名集中在这里，hub 层只通过 `ENV.xxx` 取键名。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 环境变量名。改名前先想清楚：用户已经在 shell/profile 里写过了。 */
export const ENV = {
  home: 'DWS_HUB_HOME',
  db: 'DWS_HUB_DB',
  follows: 'DWS_HUB_FOLLOWS',
  inboxCmd: 'DWS_HUB_INBOX_CMD',
  enable: 'DWS_HUB_ENABLE',
  marker: 'DWS_HUB_MARKER',
  tz: 'DWS_HUB_TZ',
  selfUser: 'DWS_HUB_SELF_USER',
  selfOpenId: 'DWS_HUB_SELF_OPEN_ID',
  selfName: 'DWS_HUB_SELF_NAME',
};

/** 数据根：`DWS_HUB_HOME`，默认 `~/.dws-hub`。 */
export function dataRoot(env = process.env) {
  return env[ENV.home] || join(homedir(), '.dws-hub');
}

/** 数据库：`DWS_HUB_DB`，默认 `<数据根>/db/dws-hub.db`。 */
export function dbPath(env = process.env) {
  return env[ENV.db] || join(dataRoot(env), 'db', 'dws-hub.db');
}

/** 会话跟进注册表：`DWS_HUB_FOLLOWS`，默认 `<数据根>/consumers/session-follows.json`。 */
export function followsPath(env = process.env) {
  return env[ENV.follows] || join(dataRoot(env), 'consumers', 'session-follows.json');
}
