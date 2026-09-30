import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';

// 加载当前执行目录下的 .env（如果存在）
dotenv.config();

const GLOBAL_CONFIG_DIR = path.join(os.homedir(), '.zhen');
const GLOBAL_CONFIG_FILE = path.join(GLOBAL_CONFIG_DIR, 'config.json');

export function resolveHome(filepath) {
  if (!filepath) return filepath;
  if (filepath.startsWith('~/') || filepath === '~') {
    return path.join(os.homedir(), filepath.slice(1));
  }
  return path.resolve(filepath);
}

export function getDefaultPrivateKey() {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.ssh', 'id_ed25519'),
    path.join(home, '.ssh', 'id_rsa'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }
  return candidates[1];
}

export function readGlobalConfig() {
  try {
    if (fs.existsSync(GLOBAL_CONFIG_FILE)) {
      const data = fs.readFileSync(GLOBAL_CONFIG_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.warn(`⚠️ 读取全局配置失败 (~/.zhen/config.json):`, err.message);
  }
  return {};
}

export function writeGlobalConfig(newConfig) {
  if (!fs.existsSync(GLOBAL_CONFIG_DIR)) {
    fs.mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(GLOBAL_CONFIG_FILE, JSON.stringify(newConfig, null, 2), 'utf-8');
}

/**
 * 将端口配置（如 "36601-36699" 或 "3000, 36601-36699"）解析展开为具体的本地与远端端口映射数组
 */
export function expandPortList(rawPorts) {
  if (!rawPorts) return [];
  const parts = String(rawPorts).split(',').map(s => s.trim()).filter(Boolean);
  const result = [];
  for (const part of parts) {
    if (part.includes('-')) {
      const cleanPart = part.includes(':') ? part.split(':')[0] : part;
      const [startStr, endStr] = cleanPart.split('-');
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      if (!isNaN(start) && !isNaN(end) && start <= end) {
        for (let p = start; p <= end; p++) {
          result.push(`${p}:${p}`);
        }
      }
    } else if (part.includes(':')) {
      result.push(part);
    } else {
      result.push(`${part}:${part}`);
    }
  }
  return result;
}

export function getConfig(cliOptions = {}) {
  const globalConf = readGlobalConfig();

  // 优先级: CLI 参数 > 当前目录 .env > 全局 ~/.zhen/config.json > 默认值
  const host = cliOptions.host || process.env.SSH_HOST || globalConf.SSH_HOST || 'my-server';
  const user = cliOptions.user || process.env.SSH_USER || globalConf.SSH_USER || 'root';
  const port = parseInt(cliOptions.port || process.env.SSH_PORT || globalConf.SSH_PORT || '22', 10);

  const keyPathRaw = cliOptions.key || process.env.SSH_KEY || globalConf.SSH_KEY || getDefaultPrivateKey();
  const keyPath = resolveHome(keyPathRaw);
  const password = cliOptions.password || process.env.SSH_PASSWORD || globalConf.SSH_PASSWORD || undefined;

  const remoteDir = cliOptions.remoteDir || process.env.REMOTE_PI_DIR || globalConf.REMOTE_PI_DIR || '/root/pi-docker/server';
  const projectsRoot = cliOptions.projectsRoot || process.env.PROJECTS_ROOT || globalConf.PROJECTS_ROOT || '/root/projects';

  // 端口范围区间配置，默认 36601-36699
  const rawPorts = cliOptions.ports || process.env.PORT_RANGE || process.env.FORWARD_PORTS || globalConf.PORT_RANGE || globalConf.FORWARD_PORTS || '36601-36699';
  const forwardPorts = expandPortList(rawPorts);

  return {
    host,
    user,
    port,
    keyPath,
    password,
    remoteDir,
    projectsRoot,
    portRange: String(rawPorts),
    forwardPorts,
  };
}
