import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

export function runConnect(config, targetProject) {
  const { host, user, port, keyPath, remoteDir, forwardPorts } = config;
  // 默认使用当前执行命令所在目录的名字作为项目名
  const projectName = targetProject || path.basename(process.cwd());

  console.log('========================================================');
  console.log(`🚀 [Zhen CLI] 正在连接远端服务器: ${user}@${host}:${port}`);
  console.log(`📂 远端服务目录: ${remoteDir}`);
  console.log(`🎯 目标项目工作区: /workspace/${projectName}`);

  const sshArgs = [
    '-p', String(port),
    '-t', // 强制分配 PTY 伪终端，确保终端交互式命令（如 bash/pi）正常工作
  ];

  // 如果私钥文件存在，指定 -i 参数
  if (keyPath && fs.existsSync(keyPath)) {
    sshArgs.push('-i', keyPath);
  }

  // 绑定端口转发隧道
  if (forwardPorts && forwardPorts.length > 0) {
    for (const p of forwardPorts) {
      const [localP, remoteP] = p.includes(':') ? p.split(':') : [p, p];
      sshArgs.push('-L', `${localP}:localhost:${remoteP}`);
    }
    const displayRange = config.portRange || (forwardPorts.length > 5 ? `${forwardPorts[0]} ~ ${forwardPorts[forwardPorts.length - 1]}` : forwardPorts.join(', '));
    console.log(`🔗 自动建立端口转发区间: ${displayRange} (共 ${forwardPorts.length} 个端口) -> 本地 localhost`);
  }

  sshArgs.push(`${user}@${host}`);

  // 远端执行命令：进入 server 目录，确保常驻容器运行，创建对应工作区并 exec 进入 bash 交互终端
  const remoteCommand = `cd '${remoteDir}' && (if [ -f ./start.sh ]; then ./start.sh >/dev/null 2>&1; else docker compose up -d >/dev/null 2>&1; fi) && docker compose exec pi mkdir -p '/workspace/${projectName}' && exec docker compose exec -w '/workspace/${projectName}' pi bash`;
  sshArgs.push(remoteCommand);

  console.log('💡 提示: 输入 exit 即可断开连接，远端容器依然会在后台保持常驻');
  console.log('========================================================\n');

  // 在 Windows 与 macOS 下使用 stdio: inherit 直接交管标准输入输出
  const sshProcess = spawn('ssh', sshArgs, {
    stdio: 'inherit',
    shell: false,
  });

  sshProcess.on('error', (err) => {
    if (err.code === 'ENOENT') {
      console.error('❌ 未检测到系统 ssh 命令！请确认系统已安装 OpenSSH（Windows 10/11 可在“可选功能”中开启，macOS 默认已自带）。');
    } else {
      console.error('❌ 启动 SSH 连接失败:', err.message);
    }
    process.exit(1);
  });

  sshProcess.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.log(`\n⚠️  SSH 会话结束，退出码: ${code}`);
    } else {
      console.log('\n👋 SSH 会话已正常断开');
    }
    process.exit(code || 0);
  });
}
