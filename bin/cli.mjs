#!/usr/bin/env node

import { Command } from 'commander';
import path from 'node:path';
import { getConfig, readGlobalConfig, writeGlobalConfig } from '../lib/config.mjs';
import { runConnect } from '../lib/connect.mjs';
import { runSync } from '../lib/sync.mjs';
import { runConfigWizard } from '../lib/wizard.mjs';

const program = new Command();

program
  .name('zhen')
  .description('跨平台 Pi Coding Agent 全局远端开发客户端 (支持 Windows & macOS)')
  .version('1.0.0');

// 统一的 SSH 全局连接参数定义
function addSshOptions(cmd) {
  return cmd
    .option('-H, --host <host>', '远端服务器 IP 或 Hostname (默认读取全局配置或 .env)')
    .option('-u, --user <user>', 'SSH 登录用户名 (默认 root)')
    .option('-p, --port <port>', 'SSH 端口 (默认 22)')
    .option('-i, --key <path>', 'SSH 私钥路径 (默认 ~/.ssh/id_rsa 或 id_ed25519)')
    .option('--password <password>', 'SSH 密码 (若不使用公钥认证时使用)');
}

// 1. connect 命令
const connectCmd = program
  .command('connect [project]')
  .description('一键建立 SSH 穿透并进入远端 Pi 容器终端（未指定项目名时默认使用当前目录名）')
  .option('-d, --remote-dir <path>', '远端服务器 pi-docker/server 所在目录 (默认 /root/pi-docker/server)')
  .option('-L, --ports <ports>', '端口转发区间或列表 (默认 36601-36699)');

addSshOptions(connectCmd).action((project, options) => {
  const config = getConfig(options);
  const targetProject = project || path.basename(process.cwd());
  runConnect(config, targetProject);
});

// 2. sync 命令
const syncCmd = program
  .command('sync')
  .description('在本地工作站与远端服务器之间进行双向全量文件同步 (全量同步，零过滤)')
  .argument('<direction>', '同步方向: "push" (本地 -> 服务器) 或 "pull" (服务器 -> 本地)')
  .argument('[source]', '源目录路径 (push 时默认当前目录，pull 时默认远端对应目录)')
  .argument('[target]', '目标目录路径 (可选，未指定时自动推导对应目录)');

addSshOptions(syncCmd).action(async (direction, source, target, options) => {
  if (direction !== 'push' && direction !== 'pull') {
    console.error('❌ 错误: 方向参数必须为 "push" 或 "pull"！');
    process.exit(1);
  }
  const config = getConfig(options);
  await runSync(direction, source, target, config);
});

// 3. config 命令 (管理全局 ~/.zhen/config.json 或启动交互向导)
program
  .command('config [action] [key] [val]')
  .description('查看、交互式引导配置或设置全局连接配置 (~/.zhen/config.json)')
  .action(async (action, key, val) => {
    if (action === 'init' || action === 'setup') {
      await runConfigWizard();
      return;
    }

    const currentGlobal = readGlobalConfig();
    if (action === 'set' && key && val) {
      // 规范化 Key 名称 (如 host -> SSH_HOST)
      const normalizedKey = key.toUpperCase().startsWith('SSH_') ? key.toUpperCase() : `SSH_${key.toUpperCase()}`;
      currentGlobal[normalizedKey] = val;
      writeGlobalConfig(currentGlobal);
      console.log(`✅ 已保存全局配置: ${normalizedKey} = ${val}`);
      console.log(`📄 配置文件位置: ~/.zhen/config.json`);
      return;
    }

    // 如果尚未配置有效主机，自动触发交互式向导
    if (!currentGlobal.SSH_HOST || currentGlobal.SSH_HOST === 'my-server') {
      console.log('💡 检测到尚未配置远端服务器信息，自动启动配置向导...\n');
      await runConfigWizard();
      return;
    }

    console.log('========================================================');
    console.log('⚙️  当前生效配置 (优先级: CLI > 当前目录 .env > 全局配置):');
    console.log(JSON.stringify(getConfig({}), null, 2));
    console.log('\n💡 提示:');
    console.log('   zhen config init           # 重新启动交互式引导配置向导');
    console.log('   zhen config set host <IP>  # 修改指定配置项');
    console.log('========================================================');
  });

// 4. init 快捷命令
program
  .command('init')
  .description('启动交互式引导配置向导 (别名: zhen config init)')
  .action(async () => {
    await runConfigWizard();
  });

// 如果执行 zhen 且没有指定子命令，或者第一个参数不是已知命令，则默认作为 connect 执行
const firstArg = process.argv[2];
if (!firstArg || (!['connect', 'sync', 'config', 'init', 'help', '-h', '--help', '-V', '--version'].includes(firstArg))) {
  // 如果第一个参数不是标准命令，把它视作项目名称
  const project = firstArg;
  const config = getConfig({});
  const targetProject = project || path.basename(process.cwd());
  runConnect(config, targetProject);
} else {
  program.parse(process.argv);
}
