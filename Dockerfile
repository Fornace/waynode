# ── Builder stage: compile frontend ──
FROM node:26.0.0-slim@sha256:ccd1c33b2876c07564b3fae7f6a5815aa42f71163faf07d00a9907e398d48bdc AS builder

WORKDIR /build

COPY frontend/package.json frontend/package-lock.json* ./frontend/
RUN cd frontend && npm ci

COPY frontend/ ./frontend/
RUN cd frontend && npm run build

# ── Runtime stage ──
FROM node:26.0.0-slim@sha256:ccd1c33b2876c07564b3fae7f6a5815aa42f71163faf07d00a9907e398d48bdc AS runtime

ARG WAYNODE_REVISION=development
LABEL org.opencontainers.image.revision=$WAYNODE_REVISION

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ripgrep \
    python3 \
    make \
    g++ \
    ca-certificates \
    curl \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI — needed for `gh run watch`, PR ops, etc.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# Install lean-ctx CLI (standalone binary for pi-lean-ctx extension)
ARG LEAN_CTX_VERSION=v3.9.9
ARG LEAN_CTX_SHA256=5e33a5f6214fcffccac38d955c56d7467adfde4455c22dbb16dd37ce05460ba4
RUN curl -fsSL -o /tmp/lean-ctx.tar.gz \
      https://github.com/yvgude/lean-ctx/releases/download/${LEAN_CTX_VERSION}/lean-ctx-x86_64-unknown-linux-musl.tar.gz && \
    echo "${LEAN_CTX_SHA256}  /tmp/lean-ctx.tar.gz" | sha256sum -c - && \
    tar xzf /tmp/lean-ctx.tar.gz -C /tmp && \
      mv /tmp/lean-ctx /usr/local/bin/lean-ctx && chmod +x /usr/local/bin/lean-ctx && \
    lean-ctx --version

WORKDIR /app

# Git identity safety net. Real attribution comes per-commit (-c flags from
# the logged-in user) and per-pi-spawn (GIT_AUTHOR_* env from the session
# owner); this global config only exists so a bare commit never fatals on
# "Author identity unknown". It must never win over a real user.
RUN git config --global user.name "Waynode" && \
    git config --global user.email "waynode@waynode.fornace.net" && \
    git config --global init.defaultBranch main

# Install server deps
COPY package.json package-lock.json* ./
RUN npm ci

# Install and verify the microsandbox runtime through the SDK setup API. The
# `microsandbox`/`msb` CLI `install` subcommand installs an OCI image and
# therefore requires an image argument; it is not the runtime installer.
RUN node --input-type=module -e \
      "import { install, isInstalled } from 'microsandbox'; await install(); if (!isInstalled()) throw new Error('microsandbox runtime verification failed')"
# Put msb on PATH so the microsandbox Node SDK can find it at runtime
# (npm ci installs it to node_modules/.bin, which isn't on PATH by default).
RUN ln -sf /app/node_modules/.bin/msb /usr/local/bin/msb

# Copy server code
COPY lib/ ./lib/
COPY routes/ ./routes/
COPY server.js ./

# Public content hub (articles + agent-readable markdown, routes/content.js)
COPY content/ ./content/

# Copy built frontend
COPY --from=builder /build/frontend/dist ./frontend/dist

# Install pi CLI
RUN npm install -g @earendil-works/pi-coding-agent@0.80.7
RUN pi install npm:pi-codex-goal@0.1.36 --approve
RUN pi install npm:pi-lean-ctx@3.9.9 --approve

# pi's fornace-llm provider config (including the API key) is written at
# CONTAINER STARTUP by lib/pi-config.mjs, from the LLM_BASE_URL / LLM_API_KEY
# runtime env vars (see docker-compose.yml env_file: .env) — never baked into
# an image layer here. Unlike sandbox/Dockerfile, this image's egress isn't
# network-scoped to the LLM host, so a build-time RUN/ENV secret would be
# recoverable by anyone with the image (e.g. `docker history`).

# Data volume
RUN mkdir -p /data/repos
VOLUME /data

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data
ENV WAYNODE_REVISION=$WAYNODE_REVISION

EXPOSE 3000

CMD ["node", "server.js"]
