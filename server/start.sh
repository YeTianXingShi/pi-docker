#!/usr/bin/env bash
set -e

# 确保脚本在自身所在目录执行
cd "$(dirname "$0")"

echo "=========================================================="
echo "🚀 正在启动 Pi Coding Agent 服务端常驻容器..."
echo "=========================================================="

# 1. 检查 Docker 服务是否正在运行
if ! docker info >/dev/null 2>&1; then
  echo "❌ 错误: Docker 守护进程未启动，请先启动 Docker 服务！"
  exit 1
fi

# 2. 如果缺少 .env，自动从 .env.example 复制
if [ ! -f .env ] && [ -f .env.example ]; then
  echo "📄 未检测到 .env 文件，已自动根据 .env.example 生成默认配置"
  cp .env.example .env
fi

# 3. 确保 Pi 配置持久化目录存在
mkdir -p data/pi

# 4. 后台拉起并常驻运行容器
docker compose up -d

echo ""
echo "✅ 服务端容器已成功在后台常驻运行！"
echo "----------------------------------------------------------"
echo "📦 容器名称: pi-agent"
echo "🔒 端口区间: 127.0.0.1:36601-36699 (本地回环绑定，全走 SSH 隧道)"
echo "💾 数据持久: $(pwd)/data/pi"
echo "📁 工作空间: ${PROJECTS_ROOT:-/root/projects} -> /workspace"
echo "----------------------------------------------------------"
echo "💡 提示: 客户端可通过 'zhen' 命令随时远程穿透直达各项目终端"
echo "=========================================================="
