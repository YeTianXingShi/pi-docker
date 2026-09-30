import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { Client } from 'ssh2';
import ignore from 'ignore';
import { resolveHome } from './config.mjs';

function toPosixPath(p) {
  return p.replace(/\\/g, '/');
}

/**
 * 递归扫描目录，遵循 .gitignore 规则并始终排除 .git 和 .DS_Store
 */
function scanDirectoryWithGitignore(baseDir) {
  const ig = ignore().add(['.git', '.git/**', '.DS_Store']);
  const gitignorePath = path.join(baseDir, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    try {
      ig.add(fs.readFileSync(gitignorePath, 'utf8'));
    } catch (e) {
      console.warn(`⚠️ 读取 .gitignore 失败:`, e.message);
    }
  }

  const files = [];

  function walk(currentDir, relPrefix = '') {
    if (!fs.existsSync(currentDir)) return;
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        // 如果目录被忽略，直接跳过不予递归（避免遍历庞大的 node_modules）
        if (ig.ignores(relPath) || ig.ignores(`${relPath}/`)) {
          continue;
        }
        walk(path.join(currentDir, entry.name), relPath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (!ig.ignores(relPath)) {
          files.push(relPath);
        }
      }
    }
  }

  walk(baseDir);
  return { files, ig };
}

/**
 * 通过 SSH 执行远端命令并收集 stdout 输出
 */
function execRemoteCommand(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      stream.on('data', (d) => { stdout += d.toString(); });
      stream.stderr.on('data', (d) => { stderr += d.toString(); });
      stream.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Command failed with code ${code}: ${stderr || stdout}`));
        }
      });
    });
  });
}

/**
 * 远端删除指定的一组孤儿文件并清理空目录
 */
function deleteRemoteFiles(conn, remoteDir, fileList) {
  return new Promise((resolve, reject) => {
    if (!fileList || fileList.length === 0) return resolve();
    // 使用 xargs 接收待删除清单
    const cmd = `cd '${remoteDir}' && xargs rm -f 2>/dev/null; find . -mindepth 1 -type d -empty -delete 2>/dev/null || true`;
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      stream.on('close', () => resolve());
      stream.end(fileList.join('\n'));
    });
  });
}

/**
 * 基于 Tar + Gzip 管道流的高速镜像同步
 * - 严格遵循 .gitignore（忽略 node_modules、.env 等）
 * - 始终排除版本控制元数据（.git/、.DS_Store）
 * - 镜像级同步：源端删除的非忽略文件在目标端自动同步删除；被忽略文件安全保留
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

    conn.on('ready', async () => {
      console.log('✅ SSH 连接就绪！分析 .gitignore 规则并准备同步...');
      const startTime = Date.now();
      let transferredBytes = 0;

      try {
        if (direction === 'push') {
          // ==========================================
          // 客户端 -> 服务器 (Push 镜像推送)
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

          console.log(`📤 [Push] 本地 -> 远端 (Tar+Gzip 极速流式传输)`);
          console.log(`📁 本地源: ${localResolved}`);
          console.log(`📁 远端源: ${remoteResolved}`);
          console.log(`🛡️  同步规则: 严格遵循 .gitignore，保护 .git/ 与远端已安装依赖`);

          // 1. 本地扫描非忽略文件
          const { files: localFiles, ig } = scanDirectoryWithGitignore(localResolved);
          const localFileSet = new Set(localFiles);
          console.log(`📋 本地待同步文件数: ${localFiles.length} (已跳过 node_modules 等被忽略目录)`);

          // 2. 确保远端目标目录存在
          await execRemoteCommand(conn, `mkdir -p '${remoteResolved}'`);

          // 3. 查询远端现有文件清单，计算需要同步删除的孤儿文件
          const remoteFileListRaw = await execRemoteCommand(conn, `cd '${remoteResolved}' && find . -type f 2>/dev/null || true`);
          const remoteFiles = remoteFileListRaw
            .split('\n')
            .map(s => s.trim().replace(/^\.\//, ''))
            .filter(Boolean);

          // 找出：在远端存在、但本地不存在、且不在 .gitignore 中的文件 -> 执行删除同步
          const filesToDelete = remoteFiles.filter(rf => {
            if (localFileSet.has(rf)) return false;
            // 如果是被 .gitignore 忽略的文件（如远端编译的 node_modules、.env、.git 等），坚决保留不删
            if (ig.ignores(rf) || ig.ignores(`${rf}/`)) return false;
            return true;
          });

          if (filesToDelete.length > 0) {
            console.log(`🗑️  正在远端同步删除 ${filesToDelete.length} 个废弃文件...`);
            await deleteRemoteFiles(conn, remoteResolved, filesToDelete);
          }

          if (localFiles.length === 0) {
            conn.end();
            console.log('\n🎉 没有需要传输的文件，本地与远端已保持最新。');
            console.log('========================================================');
            return resolve();
          }

          // 4. 打包并流式传输本地非忽略文件
          console.log('--------------------------------------------------------');
          const remoteCmd = `tar -xzf - -C '${remoteResolved}'`;

          conn.exec(remoteCmd, (err, stream) => {
            if (err) {
              conn.end();
              return reject(err);
            }

            let remoteStderr = '';
            stream.stderr.on('data', (d) => { remoteStderr += d.toString(); });

            // 本地启动 tar -czf -T -，仅打包非忽略文件清单
            const tarProc = spawn('tar', ['-czf', '-', '-C', localResolved, '-T', '-']);

            tarProc.stdout.on('data', (chunk) => {
              transferredBytes += chunk.length;
              const mb = (transferredBytes / (1024 * 1024)).toFixed(2);
              process.stdout.write(`\r⚡ 正在高速流式传输: ${mb} MB...                    `);
            });

            tarProc.on('error', (procErr) => {
              conn.end();
              reject(new Error(`本地 tar 命令启动失败: ${procErr.message}`));
            });

            // 将文件清单写入 tar 进程的 stdin
            tarProc.stdin.write(localFiles.join('\n'));
            tarProc.stdin.end();

            tarProc.stdout.pipe(stream);

            let localDone = false;
            let remoteDone = false;

            const checkComplete = () => {
              if (localDone && remoteDone) {
                conn.end();
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                const totalMb = (transferredBytes / (1024 * 1024)).toFixed(2);
                console.log(`\n\n🎉 [Push 完成] 传输压缩流 ${totalMb} MB，耗时 ${elapsed} 秒！`);
                console.log(`✅ 远端项目已与本地完全镜像同步（遵循 .gitignore 且完成删除同步）。`);
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
                console.log(`\n❌ [Push 失败] 远端解压退出码: ${code}`);
                if (remoteStderr) console.error(`远端错误信息:\n${remoteStderr}`);
                return reject(new Error(`Remote tar extraction failed with code ${code}`));
              }
              remoteDone = true;
              checkComplete();
            });
          });

        } else if (direction === 'pull') {
          // ==========================================
          // 服务器 -> 客户端 (Pull 镜像拉取)
          // ==========================================
          const currentProject = path.basename(process.cwd());
          const projectsRoot = config.projectsRoot || '/root/projects';
          const defaultRemote = `${projectsRoot}/${currentProject}`;
          const remoteResolved = toPosixPath(sourcePath || defaultRemote);
          const localResolved = resolveHome(targetPath || process.cwd());

          console.log(`📥 [Pull] 远端 -> 本地 (Tar+Gzip 极速流式传输)`);
          console.log(`📁 远端源: ${remoteResolved}`);
          console.log(`📁 本地源: ${localResolved}`);
          console.log(`🛡️  同步规则: 严格遵循 .gitignore，保护本地 .git/ 与已安装依赖`);

          // 1. 读取远端 .gitignore 内容（若存在）
          let remoteGitignoreContent = '';
          try {
            remoteGitignoreContent = await execRemoteCommand(conn, `cat '${remoteResolved}/.gitignore' 2>/dev/null || true`);
          } catch (e) {}

          const ig = ignore().add(['.git', '.git/**', '.DS_Store']);
          if (remoteGitignoreContent) {
            ig.add(remoteGitignoreContent);
          } else if (fs.existsSync(path.join(localResolved, '.gitignore'))) {
            try {
              ig.add(fs.readFileSync(path.join(localResolved, '.gitignore'), 'utf8'));
            } catch (e) {}
          }

          // 2. 获取远端文件清单并按 .gitignore 过滤
          const remoteFileListRaw = await execRemoteCommand(conn, `cd '${remoteResolved}' && find . -type f 2>/dev/null || true`);
          const validRemoteFiles = remoteFileListRaw
            .split('\n')
            .map(s => s.trim().replace(/^\.\//, ''))
            .filter(rf => rf && !ig.ignores(rf) && !ig.ignores(`${rf}/`));

          const remoteFileSet = new Set(validRemoteFiles);
          console.log(`📋 远端有效同步文件数: ${validRemoteFiles.length} (已跳过被忽略文件)`);

          // 3. 本地扫描现有文件，找出需同步删除的本地孤儿文件
          const { files: currentLocalFiles } = scanDirectoryWithGitignore(localResolved);
          const localFilesToDelete = currentLocalFiles.filter(lf => {
            if (remoteFileSet.has(lf)) return false;
            if (ig.ignores(lf) || ig.ignores(`${lf}/`)) return false;
            return true;
          });

          if (localFilesToDelete.length > 0) {
            console.log(`🗑️  正在本地同步删除 ${localFilesToDelete.length} 个废弃文件...`);
            for (const f of localFilesToDelete) {
              const fullP = path.join(localResolved, f);
              try { fs.rmSync(fullP, { force: true }); } catch (e) {}
            }
          }

          if (validRemoteFiles.length === 0) {
            conn.end();
            console.log('\n🎉 远端没有需要拉取的文件。');
            console.log('========================================================');
            return resolve();
          }

          // 4. 远端打包非忽略文件流并拉取到本地解压
          console.log('--------------------------------------------------------');
          const remoteCmd = `cd '${remoteResolved}' && tar -czf - -T -`;

          conn.exec(remoteCmd, (err, stream) => {
            if (err) {
              conn.end();
              return reject(err);
            }

            let remoteStderr = '';
            stream.stderr.on('data', (d) => { remoteStderr += d.toString(); });

            if (!fs.existsSync(localResolved)) {
              fs.mkdirSync(localResolved, { recursive: true });
            }

            // 本地启动 tar -xzf 接收流
            const tarProc = spawn('tar', ['-xzf', '-', '-C', localResolved]);

            stream.on('data', (chunk) => {
              transferredBytes += chunk.length;
              const mb = (transferredBytes / (1024 * 1024)).toFixed(2);
              process.stdout.write(`\r⚡ 正在高速流式传输与本地解包: ${mb} MB...                    `);
            });

            tarProc.on('error', (procErr) => {
              conn.end();
              reject(new Error(`本地 tar 解压启动失败: ${procErr.message}`));
            });

            // 向远端 tar 的 stdin 写入有效文件清单
            stream.write(validRemoteFiles.join('\n'));
            stream.end();

            stream.pipe(tarProc.stdin);

            let remoteDone = false;
            let localDone = false;

            const checkComplete = () => {
              if (remoteDone && localDone) {
                conn.end();
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                const totalMb = (transferredBytes / (1024 * 1024)).toFixed(2);
                console.log(`\n\n🎉 [Pull 完成] 传输压缩流 ${totalMb} MB，耗时 ${elapsed} 秒！`);
                console.log(`✅ 本地项目已与远端完全镜像同步（遵循 .gitignore 且完成删除同步）。`);
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
      } catch (opErr) {
        conn.end();
        console.error(`\n❌ 同步操作失败:`, opErr.message);
        reject(opErr);
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
