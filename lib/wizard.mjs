import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { input, select, password, confirm } from '@inquirer/prompts';
import { Client } from 'ssh2';
import {
  resolveHome,
  getDefaultPrivateKey,
  readGlobalConfig,
  writeGlobalConfig,
} from './config.mjs';

/**
 * 测试 SSH 连通性
 */
export async function testSshConnection(config) {
  return new Promise((resolve) => {
    const conn = new Client();
    const connOpts = {
      host: config.SSH_HOST,
      port: parseInt(config.SSH_PORT || '22', 10),
      username: config.SSH_USER || 'root',
      readyTimeout: 10000,
    };

    if (config.SSH_KEY) {
      const resolvedKey = resolveHome(config.SSH_KEY);
      if (fs.existsSync(resolvedKey)) {
        try {
          connOpts.privateKey = fs.readFileSync(resolvedKey);
        } catch (e) {
          return resolve({ success: false, error: `读取私钥失败: ${e.message}` });
        }
      }
    }

    if (config.SSH_PASSWORD) {
      connOpts.password = config.SSH_PASSWORD;
    }

    conn.on('ready', () => {
      conn.end();
      resolve({ success: true });
    });

    conn.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });

    try {
      conn.connect(connOpts);
    } catch (err) {
      resolve({ success: false, error: err.message });
    }
  });
}

/**
 * 寻找本地匹配的公钥文件 (.pub)
 */
function findPublicKey(privateKeyPath) {
  const pubPath = `${privateKeyPath}.pub`;
  if (fs.existsSync(pubPath)) {
    return pubPath;
  }
  const home = os.homedir();
  const candidates = [
    path.join(home, '.ssh', 'id_ed25519.pub'),
    path.join(home, '.ssh', 'id_rsa.pub'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * 将本地公钥通过已连接的会话写入远端 ~/.ssh/authorized_keys
 */
async function installPublicKey(config) {
  const pubFile = findPublicKey(resolveHome(config.SSH_KEY || getDefaultPrivateKey()));
  if (!pubFile || !fs.existsSync(pubFile)) {
    console.log('⚠️ 未检测到本地公钥文件（.pub），跳过免密公钥写入。');
    return false;
  }

  const pubKeyContent = fs.readFileSync(pubFile, 'utf-8').trim();
  console.log(`📤 正在将本地公钥 (${path.basename(pubFile)}) 写入服务器 authorized_keys...`);

  return new Promise((resolve) => {
    const conn = new Client();
    conn.on('ready', () => {
      const cmd = `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo "${pubKeyContent}" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`;
      conn.exec(cmd, (err, stream) => {
        if (err) {
          conn.end();
          return resolve(false);
        }
        stream.on('close', () => {
          conn.end();
          resolve(true);
        });
      });
    });
    conn.on('error', () => resolve(false));
    conn.connect({
      host: config.SSH_HOST,
      port: parseInt(config.SSH_PORT || '22', 10),
      username: config.SSH_USER || 'root',
      password: config.SSH_PASSWORD,
      readyTimeout: 10000,
    });
  });
}

/**
 * 启动交互式引导配置向导
 */
export async function runConfigWizard() {
  console.log('\n========================================================');
  console.log('🛠️  欢迎使用 Zhen 远端开发客户端配置向导');
  console.log('将引导你配置远端服务器连接信息 (保存在 ~/.zhen/config.json)');
  console.log('========================================================\n');

  const currentConfig = readGlobalConfig();

  // 1. Host
  const host = await input({
    message: '请输入远端云服务器 IP 地址或域名 (Host):',
    default: currentConfig.SSH_HOST && currentConfig.SSH_HOST !== 'my-server' ? currentConfig.SSH_HOST : undefined,
    validate: (val) => (val && val.trim().length > 0 ? true : '服务器地址不能为空！'),
  });

  // 2. Port
  const port = await input({
    message: '请输入 SSH 端口 (Port):',
    default: currentConfig.SSH_PORT || '22',
    validate: (val) => {
      const p = parseInt(val, 10);
      return !isNaN(p) && p > 0 && p <= 65535 ? true : '请输入 1-65535 之间的有效端口号！';
    },
  });

  // 3. User
  const user = await input({
    message: '请输入 SSH 登录用户名 (User):',
    default: currentConfig.SSH_USER || 'root',
    validate: (val) => (val && val.trim().length > 0 ? true : '用户名不能为空！'),
  });

  // 4. Auth Method
  const authMethod = await select({
    message: '请选择 SSH 身份认证方式:',
    choices: [
      {
        name: '🔑 SSH 私钥认证 (推荐，安全无感，支持终端自动免密)',
        value: 'key',
      },
      {
        name: '🔒 账号密码认证 (输入密码，支持自动录入免密公钥)',
        value: 'password',
      },
    ],
    default: currentConfig.SSH_PASSWORD ? 'password' : 'key',
  });

  let keyPath = undefined;
  let pass = undefined;

  if (authMethod === 'key') {
    const defaultKey = getDefaultPrivateKey();
    keyPath = await input({
      message: '请输入 SSH 私钥文件路径 (Key Path):',
      default: currentConfig.SSH_KEY || (fs.existsSync(defaultKey) ? defaultKey : '~/.ssh/id_rsa'),
    });

    const resolved = resolveHome(keyPath);
    if (!fs.existsSync(resolved)) {
      console.log(`⚠️  注意: 当前本地尚未找到私钥文件 (${keyPath})，请确保后续连接前已就绪。`);
    }
  } else {
    pass = await password({
      message: '请输入 SSH 登录密码:',
      mask: '*',
      validate: (val) => (val && val.length > 0 ? true : '密码不能为空！'),
    });
  }

  // 5. Advanced Settings
  const needAdvanced = await confirm({
    message: '是否需要配置高级参数？(如远端 pi-docker 目录、调试端口区间等)',
    default: false,
  });

  let remoteDir = currentConfig.REMOTE_PI_DIR || '/root/pi-docker/server';
  let portRange = currentConfig.PORT_RANGE || '36601-36699';
  let projectsRoot = currentConfig.PROJECTS_ROOT || '/root/projects';

  if (needAdvanced) {
    remoteDir = await input({
      message: '远端 pi-docker/server 所在目录 (REMOTE_PI_DIR):',
      default: remoteDir,
    });

    portRange = await input({
      message: '调试端口映射区间 (PORT_RANGE):',
      default: portRange,
    });

    projectsRoot = await input({
      message: '远端项目代码存放根目录 (PROJECTS_ROOT):',
      default: projectsRoot,
    });
  }

  // 组装新配置对象
  const newConfig = {
    ...currentConfig,
    SSH_HOST: host.trim(),
    SSH_PORT: port.trim(),
    SSH_USER: user.trim(),
    REMOTE_PI_DIR: remoteDir.trim(),
    PORT_RANGE: portRange.trim(),
    PROJECTS_ROOT: projectsRoot.trim(),
  };

  if (authMethod === 'key') {
    newConfig.SSH_KEY = keyPath.trim();
    delete newConfig.SSH_PASSWORD;
  } else {
    newConfig.SSH_PASSWORD = pass;
    // 如果已有默认密钥，也记录一下备用
    const detectedKey = getDefaultPrivateKey();
    if (detectedKey && fs.existsSync(detectedKey)) {
      newConfig.SSH_KEY = detectedKey;
    }
  }

  // 6. 即时 SSH 连通性测试
  console.log('\n----------------------------------------------------------');
  console.log(`📡 正在验证与服务器 ${user}@${host}:${port} 的 SSH 连接...`);

  const testResult = await testSshConnection(newConfig);

  if (testResult.success) {
    console.log('✅ SSH 连接测试成功！凭据与主机完全有效。');

    // 如果选了密码认证，询问是否自动安装公钥免密
    if (authMethod === 'password') {
      const doInstallKey = await confirm({
        message: '是否现在将本地公钥自动上传到服务器，开启后续终端连接完全免密？',
        default: true,
      });

      if (doInstallKey) {
        const installed = await installPublicKey(newConfig);
        if (installed) {
          console.log('🎉 公钥已成功写入服务器！后续执行 zhen 终端连接无需每次输密码。');
          const defaultKey = getDefaultPrivateKey();
          if (defaultKey) {
            newConfig.SSH_KEY = defaultKey;
          }
        } else {
          console.log('⚠️ 公钥写入未能完成，你依然可正常使用密码登录。');
        }
      }
    }

    writeGlobalConfig(newConfig);
    console.log('\n🎉 配置已成功保存至 ~/.zhen/config.json！');
  } else {
    console.log(`❌ SSH 连接测试失败: ${testResult.error}`);
    const saveAnyway = await confirm({
      message: '连接测试未成功（可能是由于网络暂不可达或密码错误），是否仍然保存该配置？',
      default: true,
    });

    if (saveAnyway) {
      writeGlobalConfig(newConfig);
      console.log('💾 已保存配置至 ~/.zhen/config.json。请检查网络或在需要时执行 "zhen config init" 重新配置。');
    } else {
      console.log('👋 已放弃保存配置。');
      return;
    }
  }

  console.log('========================================================');
  console.log('💡 快速开始:');
  console.log('   cd <你的任意项目目录>');
  console.log('   zhen            # 一键建立隧道直达容器项目工作区');
  console.log('   zhen sync push  # 全量同步当前项目到云端');
  console.log('========================================================\n');
}
