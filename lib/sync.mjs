import path from 'node:path';
import fs from 'node:fs';
import Client from 'ssh2-sftp-client';
import { resolveHome } from './config.mjs';

function toPosixPath(p) {
  return p.replace(/\\/g, '/');
}

export async function runSync(direction, sourcePath, targetPath, config) {
  const sftp = new Client();

  const connectOptions = {
    host: config.host,
    port: config.port,
    username: config.user,
    readyTimeout: 20000,
  };

  if (config.keyPath && fs.existsSync(config.keyPath)) {
    try {
      connectOptions.privateKey = fs.readFileSync(config.keyPath);
    } catch (e) {
      console.warn(`⚠️ 读取私钥文件失败 (${config.keyPath}):`, e.message);
    }
  }

  if (config.password) {
    connectOptions.password = config.password;
  }

  try {
    console.log('========================================================');
    console.log(`📡 正在建立 SFTP 连接: ${config.user}@${config.host}:${config.port}...`);
    await sftp.connect(connectOptions);
    console.log('✅ SFTP 连接成功！准备执行全量同步...');

    let transferredCount = 0;
    const projectsRoot = config.projectsRoot || '/root/projects';

    if (direction === 'push') {
      // 客户端 -> 服务器 (Upload)
      const rawSource = sourcePath || process.cwd();
      const localResolved = resolveHome(rawSource);
      if (!fs.existsSync(localResolved)) {
        throw new Error(`本地源目录不存在: ${localResolved}`);
      }

      const projectName = path.basename(localResolved);
      const defaultRemote = `${projectsRoot}/${projectName}`;
      const remoteResolved = toPosixPath(targetPath || defaultRemote);

      console.log(`📤 [Push] 本地目录 -> 远端目录`);
      console.log(`📁 本地: ${localResolved}`);
      console.log(`📁 远端: ${remoteResolved}`);
      console.log(`⚡ 模式: 全量同步 (不做任何文件忽略)`);
      console.log('--------------------------------------------------------');

      sftp.on('upload', (info) => {
        transferredCount++;
        process.stdout.write(`\r🚀 正在上传 [${transferredCount}]: ${path.basename(info.source)}                    `);
      });

      // 确保远端目标目录存在
      await sftp.mkdir(remoteResolved, true);

      // 全量上传：不传 filter 选项，完整同步所有文件
      await sftp.uploadDir(localResolved, remoteResolved);

      console.log(`\n\n🎉 [Push 完成] 共计同步 ${transferredCount} 个文件至远端: ${remoteResolved}`);

    } else if (direction === 'pull') {
      // 服务器 -> 客户端 (Download)
      const currentProject = path.basename(process.cwd());
      const defaultRemote = `${projectsRoot}/${currentProject}`;
      const remoteResolved = toPosixPath(sourcePath || defaultRemote);
      const localResolved = resolveHome(targetPath || process.cwd());

      console.log(`📥 [Pull] 远端目录 -> 本地目录`);
      console.log(`📁 远端: ${remoteResolved}`);
      console.log(`📁 本地: ${localResolved}`);
      console.log(`⚡ 模式: 全量同步 (不做任何文件忽略)`);
      console.log('--------------------------------------------------------');

      sftp.on('download', (info) => {
        transferredCount++;
        process.stdout.write(`\r🚀 正在下载 [${transferredCount}]: ${path.basename(info.source)}                    `);
      });

      if (!fs.existsSync(localResolved)) {
        fs.mkdirSync(localResolved, { recursive: true });
      }

      // 全量下载：不传 filter 选项，完整下载所有文件
      await sftp.downloadDir(remoteResolved, localResolved);

      console.log(`\n\n🎉 [Pull 完成] 共计下载 ${transferredCount} 个文件至本地: ${localResolved}`);
    } else {
      throw new Error(`未知的同步方向: ${direction}，仅支持 push 或 pull`);
    }

    console.log('========================================================');
  } catch (err) {
    console.error(`\n❌ 同步操作失败:`, err.message);
    process.exit(1);
  } finally {
    await sftp.end();
  }
}
