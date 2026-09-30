# Pi Docker & Zhen CLI (跨平台动态远端开发沙箱)

容器化运行 [Pi Coding Agent (`@earendil-works/pi-coding-agent`)](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 的轻量级开发沙箱与跨平台全局客户端 `zhen`。

支持在远端云服务器（Linux VPS）上常驻 Docker 容器，并在本地 **Windows** 或 **macOS** 上通过全局命令 `zhen` 实现项目动态联动、极速终端穿透与双向全量文件同步。

---

## 🌟 核心特性

- 🎯 **与客户端项目动态联动**：
  - 服务端无需固定任何项目目录，统一挂载 `/root/projects:/workspace`；
  - 客户端在任意本地项目目录下运行 `zhen connect`（或直接运行 `zhen`），容器无需重启，秒级进入该项目专属工作区（`/workspace/<当前项目名>`）。
- 💾 **项目内配置持久化**：
  - Pi 的所有配置与会话状态存放在本项目内（`server/data/pi`），彻底脱离系统全局目录 `~/.pi/agent`，迁移与备份极度清爽。
- 💻 **全局 npm 命令（zhen）**：
  - 一次全局安装（`npm install -g .`），在电脑上任何工程目录下随处可用，无需依赖 `.sh` 脚本。
- ⚙️ **全局配置中心（`~/.zhen/config.json`）**：
  - 只需一次性设置服务器 Host 与 Key（如 `zhen config set host 1.2.3.4`），后续在任何项目目录中都能即开即用。
- 🔄 **双向全量文件同步（`sync`）**：
  - `zhen sync push`：将当前本地工程目录全量推送到云端 `/root/projects/<项目名>`（零过滤）。
  - `zhen sync pull`：将云端项目全量拉取回当前本地工程目录。
- 🔒 **纯 SSH 隧道安全调试 (支持端口范围区间)**：
  - 容器端口通过区间形式映射并绑定到服务端的 `127.0.0.1`（默认 `36601-36699`，支持环境变量灵活配置），彻底杜绝公网暴露；
  - 客户端连接时自动通过 SSH 隧道批量映射到本地 `localhost`，容器内启动在此区间的任何服务，本地均可直接秒级预览。

---

## 📁 目录结构

```text
pi-docker/
├── server/                  # 🖥️ 服务端模块 (云服务器专用)
│   ├── Dockerfile           # 容器定义：基于 ubuntu:24.04 构建，内置最新 Node.js、Python 与 pi agent
│   ├── docker-compose.yml   # 动态工作区 (/root/projects) 与项目内配置持久化 (./data/pi)
│   ├── start.sh             # 服务端后台常驻与动态项目直达脚本
│   ├── .env.example         # 服务端环境配置模板 (root 用户与权限)
│   └── .gitignore           # 保护 server/data/ 凭据数据
├── bin/
│   └── cli.mjs              # 💻 全局 zhen CLI 主入口 (Windows & macOS 原生)
├── lib/
│   ├── config.mjs           # 全局 ~/.zhen/config.json 与当前 .env 优先级合并
│   ├── connect.mjs          # 动态项目直达终端与端口隧道
│   └── sync.mjs             # SFTP 双向全量同步引擎 (默认当前项目)
├── package.json             # 注册全局命令 zhen
├── .env.example             # 客户端连接配置模板
├── .gitignore               # 保护敏感与临时文件
└── README.md                # 项目完整说明文档
```

---

## 🚀 客户端安装与配置 (本地 Windows & macOS)

### 1. 全局安装 `zhen` 命令

在本地克隆或进入 `pi-docker` 目录：
```bash
npm install
npm install -g .
# 或使用: npm link
```

验证安装：
```bash
zhen --help
```

### 2. 初始化全局连接配置

只需配置一次服务器信息（保存在 `~/.zhen/config.json`）：

```bash
# 设置云服务器 IP
zhen config set host <你的服务器公网IP>

# 设置 SSH 用户 (默认 root)
zhen config set user root

# 设置私钥路径 (默认 ~/.ssh/id_rsa 或 id_ed25519)
zhen config set key ~/.ssh/id_rsa

# 查看当前生效配置
zhen config
```

> [!TIP]
> 如果某个特殊项目有独立的服务器或端口，也可在该项目根目录下创建 `.env`，其优先级会自动覆盖全局配置。

---

## 🛠️ 日常开发使用 (在任意项目目录下)

平时开发时，只需打开本地终端，进入你的任意项目目录（例如 `~/vscode-projects/DetradeTestTools`）：

### 1. 一键连接并直达项目 (`connect`)

```bash
cd ~/vscode-projects/DetradeTestTools

# 直接执行 zhen (或 zhen connect)
zhen
```

**发生了什么？**
1. 自动提取当前目录名称 `DetradeTestTools`；
2. 建立 SSH 安全通道并映射 36601-36699 端口区间到本地；
3. 容器内部自动创建并进入 `/workspace/DetradeTestTools` 交互终端；
4. 退出（输入 `exit`）后，容器仍在云端后台常驻。

### 2. 本地项目推送到云端 (`sync push`)

```bash
cd ~/vscode-projects/DetradeTestTools

# 全量推送当前项目到服务器 /root/projects/DetradeTestTools
zhen sync push
```

### 3. 云端项目拉取到本地 (`sync pull`)

```bash
cd ~/vscode-projects/DetradeTestTools

# 全量将云端 /root/projects/DetradeTestTools 覆盖拉取回本地
zhen sync pull
```

---

## 💻 搭配 VS Code Remote 进行远程开发

除了通过命令行终端使用 `zhen`，你还可以使用本地 **VS Code** 或 **Cursor** 的远程开发功能，直接在远端服务器上编辑代码，享受与本地完全一致的智能补全、Git 比较与实时调试体验。

### 1. 安装扩展
在本地 VS Code 扩展市场搜索并安装：
- **Remote - SSH**（`ms-vscode-remote.remote-ssh`）
- *(可选)* **Dev Containers**（`ms-vscode-remote.remote-containers`，若希望直接将编辑器附着进容器内部）

### 2. 配置本地 SSH 主机
在本地电脑的 `~/.ssh/config` 中添加你的服务器配置（Windows 位于 `C:\Users\<用户名>\.ssh\config`）：
```ssh-config
Host my-pi-server
    HostName <你的服务器公网IP>
    User root
    IdentityFile ~/.ssh/id_rsa
    ServerAliveInterval 60
```

### 3. 连接远端服务器并打开项目
1. 按下快捷键 `Cmd + Shift + P`（macOS）或 `Ctrl + Shift + P`（Windows）；
2. 输入并选择 **`Remote-SSH: Connect to Host...`**，点击 `my-pi-server`；
3. 连接成功后在新窗口中点击 **File -> Open Folder**；
4. 选择打开远端项目目录：`/root/projects/DetradeTestTools`。

### 4. 在 VS Code 内部与 Pi 容器联动
打开 VS Code 内置终端（快捷键 `` Ctrl + ` ``）：
- **进入 Pi 容器终端**：直接在终端执行：
  ```bash
  cd /root/pi-docker/server && ./start.sh DetradeTestTools
  ```
- **Attach 进容器开发（可选）**：
  若安装了 Dev Containers 扩展，可按 `Cmd/Ctrl + Shift + P` 执行 **`Dev Containers: Attach to Running Container...`**，选择 `pi-agent` 容器，即可把整个 VS Code 界面直接嵌入容器内部开发。

### 5. Web 预览与端口自动映射
当 Pi 或你在终端启动了 Web 服务（如 `npm run dev` 监听 3000、8080 端口）：
- VS Code Remote-SSH 会**自动捕获并建立本地端口转发**；
- 在 VS Code 底部面板的 **“端口 (PORTS)”** 标签页中，点击地球图标即可在本地浏览器中直接访问 `http://localhost:3000`，无需在云服务器防火墙开放端口。

---

## 🖥️ 服务端极简部署 (云服务器只需部署一次)

1. 在云服务器上克隆 `pi-docker`：
   ```bash
   cd /root
   git clone <pi-docker-git-url> pi-docker
   ```
2. 进入 `server` 目录并启动：
   ```bash
   cd /root/pi-docker/server
   cp .env.example .env
   chmod +x start.sh
   ./start.sh
   ```
3. 启动后：
   - 容器已在后台常驻运行；
   - Pi 配置保存在 `/root/pi-docker/server/data/pi`；
   - 所有项目统一挂载到 `/root/projects`；
   - 客户端即可在本地通过 `zhen` 命令随时穿透与同步任意项目！
