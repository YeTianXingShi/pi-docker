#!/usr/bin/env bash
set -e

# 确保脚本在自身所在目录执行
cd "$(dirname "$0")"

# 1. 检查 Docker 服务是否正在运行
if ! docker info >/dev/null 2>&1; then
  echo "❌ Docker 守护进程未启动，请先打开 Docker 服务！"
  exit 1
fi

# 2. 确保常驻容器在后台运行（若已在运行则秒级跳过，未运行则自动启动）
docker compose up -d

TARGET_PROJECT="${1:-}"

if [ -n "$TARGET_PROJECT" ]; then
  # 确保目标项目目录存在
  docker compose exec pi mkdir -p "/workspace/${TARGET_PROJECT}"
  echo "✨ 已进入持久化容器终端（项目直达: /workspace/${TARGET_PROJECT}）..."
  echo "💡 提示: 输入 exit 退出终端，容器仍会在后台保持运行"
  exec docker compose exec -w "/workspace/${TARGET_PROJECT}" pi bash
else
  echo "✨ 已进入持久化容器终端（工作区根目录: /workspace）..."
  echo "💡 提示: 输入 exit 退出终端，容器仍会在后台保持运行"
  exec docker compose exec -w "/workspace" pi bash
fi
