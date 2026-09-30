import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { Client } from 'ssh2';
import { resolveHome } from './config.mjs';

function toPosixPath(p) {
  return p.replace(/\\/g, '/');
}

/**
 * 清空本地目录内部的所有文件与子目录（保留目录本身，实现同步删除）
 */
function cleanLocalDir(targetDir) {
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
    return;
  }
  const entries = fs.readdirSync(targetDir);
  for (const entry of entries) {
    const fullPath = path.join(targetDir, entry);
    fs.rmSync(fullPath, { recursive: true, force: true });
  }
}

/**
 * 基于 Tar + Gzip 管道流的高速全量镜像同步（包含删除同步）
 */
export async function runSync(direction, sourcePath, targetPath, config) {
  return new Promise((resolve, reject) => {
    const conn = new Client();

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

    console.log('========================================================');
    console.log(`📡 正在连接服务器: ${config.user}@${config.host}:${config.port}...`);

    conn.on('ready', () => {
      console.log('✅ SSH 连接就绪！准备执行高速全量镜像同步（含删除同步）...');
      const startTime = Date.now();
      let transferredBytes = 0;

      if (direction === 'push') {
        // ==========================================
        // 客户端 -> 服务器 (Push 全量镜像推送)
        // ==========================================
        const rawSource = sourcePath || process.cwd();
        const localResolved = resolveHome(rawSource);
        if (!fs.existsSync(localResolved)) {
          conn.end();
          return reject(new Error(`本地源目录不存在: ${localResolved}`));
        }

        const projectName = path.basename(localResolved);
        const projectsRoot = config.projectsRoot || '/root/projects';
        const defaultRemote = `${projectsRoot}/${projectName}`;
        const remoteResolved = toPosixPath(targetPath || defaultRemote);

        console.log(`📤 [Push] 本地目录 -> 远端目录 (Tar+Gzip 高速流式传输)`);
        console.log(`📁 本地源目录: ${localResolved}`);
        console.log(`📁 远端目标目录: ${remoteResolved}`);
        console.log(`🔄 镜像同步策略: 全量镜像覆盖 (远端多余文件将被同步删除)`);
        console.log('--------------------------------------------------------');

        // 远端先清空目标目录内部所有文件（保留目录本身），然后接收流解压
        const remoteCmd = `mkdir -p '${remoteResolved}' && find '${remoteResolved}' -mindepth 1 -delete 2>/dev/null || (rm -rf '${remoteResolved}'/* '${remoteResolved}'/.[!.]* 2>/dev/null || true); tar -xzf - -C '${remoteResolved}'`;

        conn.exec(remoteCmd, (err, stream) => {
          if (err) {
            conn.end();
            return reject(err);
          }

          let remoteStderr = '';
          stream.stderr.on('data', (d) => {
            remoteStderr += d.toString();
          });

          // 本地启动 tar -czf 流式打包
          const tarProc = spawn('tar', ['-czf', '-', '-C', localResolved, '.']);

          tarProc.stdout.on('data', (chunk) => {
            transferredBytes += chunk.length;
            const mb = (transferredBytes / (1024 * 1024)).toFixed(2);
            process.stdout.write(`\r⚡ 正在高速流式传输与远端解包: ${mb} MB...                    `);
          });

          tarProc.on('error', (procErr) => {
            conn.end();
            reject(new Error(`本地 tar 命令执行失败: ${procErr.message}`));
          });

          tarProc.stdout.pipe(stream);

          let localDone = false;
          let remoteDone = false;

          const checkComplete = () => {
            if (localDone && remoteDone) {
              conn.end();
              const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
              const totalMb = (transferredBytes / (1024 * 1024)).toFixed(2);
              console.log(`\n\n🎉 [Push 完成] 压缩流传输 ${totalMb} MB，耗时 ${elapsed} 秒！`);
              console.log(`✅ 远端项目已与本地完全镜像一致（本地删除的文件已在远端同步删除）。`);
              console.log('========================================================');
              resolve();
            }
          };

          tarProc.on('close', () => {
            localDone = true;
            checkComplete();
          });

          stream.on('close', (code) => {
            if (code !== 0) {
              conn.end();
              console.log(`\n❌ [Push 失败] 远端解包异常退出，退出码: ${code}`);
              if (remoteStderr) console.error(`远端错误信息:\n${remoteStderr}`);
              return reject(new Error(`Remote tar extraction failed with code ${code}`));
            }
            remoteDone = true;
            checkComplete();
          });
        });

      } else if (direction === 'pull') {
        // ==========================================
        // 服务器 -> 客户端 (Pull 全量镜像拉取)
        // ==========================================
        const currentProject = path.basename(process.cwd());
        const projectsRoot = config.projectsRoot || '/root/projects';
        const defaultRemote = `${projectsRoot}/${currentProject}`;
        const remoteResolved = toPosixPath(sourcePath || defaultRemote);
        const localResolved = resolveHome(targetPath || process.cwd());

        console.log(`📥 [Pull] 远端目录 -> 本地目录 (Tar+Gzip 高速流式传输)`);
        console.log(`📁 远端源目录: ${remoteResolved}`);
        console.log(`📁 本地目标目录: ${localResolved}`);
        console.log(`🔄 镜像同步策略: 全量镜像覆盖 (本地多余文件将被同步删除)`);
        console.log('--------------------------------------------------------');

        // 远端流式打包
        const remoteCmd = `tar -czf - -C '${remoteResolved}' .`;

        conn.exec(remoteCmd, (err, stream) => {
          if (err) {
            conn.end();
            return reject(err);
          }

          let remoteStderr = '';
          stream.stderr.on('data', (d) => {
            remoteStderr += d.toString();
          });

          // 清空本地目标目录内容（实现删除同步）
          try {
            cleanLocalDir(localResolved);
          } catch (cleanErr) {
            conn.end();
            return reject(new Error(`清理本地目录失败: ${cleanErr.message}`));
          }

          // 本地启动 tar -xzf 接收流解压
          const tarProc = spawn('tar', ['-xzf', '-', '-C', localResolved]);

          stream.on('data', (chunk) => {
            transferredBytes += chunk.length;
            const mb = (transferredBytes / (1024 * 1024)).toFixed(2);
            process.stdout.write(`\r⚡ 正在高速流式拉取与本地落盘: ${mb} MB...                    `);
          });

          tarProc.on('error', (procErr) => {
            conn.end();
            reject(new Error(`本地 tar 解压执行失败: ${procErr.message}`));
          });

          stream.pipe(tarProc.stdin);

          let remoteDone = false;
          let localDone = false;

          const checkComplete = () => {
            if (remoteDone && localDone) {
              conn.end();
              const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
              const totalMb = (transferredBytes / (1024 * 1024)).toFixed(2);
              console.log(`\n\n🎉 [Pull 完成] 压缩流传输 ${totalMb} MB，耗时 ${elapsed} 秒！`);
              console.log(`✅ 本地项目已与远端完全镜像一致（远端删除的文件已在本地同步删除）。`);
              console.log('========================================================');
              resolve();
            }
          };

          stream.on('close', (code) => {
            if (code !== 0) {
              conn.end();
              console.log(`\n❌ [Pull 失败] 远端打包异常退出，退出码: ${code}`);
              if (remoteStderr) console.error(`远端错误信息:\n${remoteStderr}`);
              return reject(new Error(`Remote tar command failed with code ${code}`));
            }
            remoteDone = true;
            checkComplete();
          });

          tarProc.on('close', (code) => {
            if (code !== 0) {
              conn.end();
              return reject(new Error(`Local tar extraction failed with code ${code}`));
            }
            localDone = true;
            checkComplete();
          });
        });
      } else {
        conn.end();
        reject(new Error(`未知的同步方向: ${direction}，仅支持 push 或 pull`));
      }
    });

    conn.on('error', (err) => {
      console.error(`\n❌ SSH 连接失败:`, err.message);
      reject(err);
    });

    try {
      conn.connect(connectOptions);
    } catch (err) {
      reject(err);
    }
  });
}
