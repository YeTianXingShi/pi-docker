FROM ubuntu:24.04

# 避免 apt 交互式提示，并允许 pip 在容器环境直接安装包
ENV DEBIAN_FRONTEND=noninteractive \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# 1. 安装系统基础工具、构建工具与 Python 完整环境
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    gnupg \
    wget \
    jq \
    build-essential \
    python3 \
    python3-pip \
    python3-venv \
    python3-dev \
    python-is-python3 \
  && rm -rf /var/lib/apt/lists/*

# 2. 通过 NodeSource 官方仓库安装最新版 Node.js 与 npm
RUN curl -fsSL https://deb.nodesource.com/setup_current.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && npm install -g npm@latest \
  && rm -rf /var/lib/apt/lists/*

# 3. 全局安装 Pi Coding Agent
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

WORKDIR /workspace

ENTRYPOINT ["pi"]