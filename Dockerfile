# ── Builder stage: compile frontend ──
FROM node:26-slim AS builder

WORKDIR /build

COPY frontend/package.json frontend/package-lock.json* ./frontend/
RUN cd frontend && npm ci || npm install

COPY frontend/ ./frontend/
RUN cd frontend && npm run build

# ── Runtime stage ──
FROM node:26-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ripgrep \
    python3 \
    make \
    g++ \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install lean-ctx CLI (standalone binary for pi-lean-ctx extension)
RUN curl -fsSL https://github.com/yvgude/lean-ctx/releases/download/v3.8.11/lean-ctx-x86_64-unknown-linux-musl.tar.gz | tar xzf - -C /tmp && \
    mv /tmp/lean-ctx /usr/local/bin/lean-ctx && chmod +x /usr/local/bin/lean-ctx || echo "lean-ctx install failed, pi-lean-ctx will run without it"

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
RUN npm ci || npm install

# microsandbox runtime: libkrunfw + msb binary (platform package). Needed for
# the container to boot hardware-isolated microVMs. No-op on hosts without
# /dev/kvm (isSandboxAvailable() returns false, falls back to direct pi).
RUN npx microsandbox install || echo "msb runtime install failed (KVM sandboxing disabled)"
# Put msb on PATH so the microsandbox Node SDK can find it at runtime
# (npm ci installs it to node_modules/.bin, which isn't on PATH by default).
RUN ln -sf /app/node_modules/.bin/msb /usr/local/bin/msb

# Copy server code
COPY lib/ ./lib/
COPY routes/ ./routes/
COPY server.js ./

# Copy built frontend
COPY --from=builder /build/frontend/dist ./frontend/dist

# Install pi CLI
RUN npm install -g @earendil-works/pi-coding-agent@latest
RUN pi install npm:pi-codex-goal --approve || true
RUN pi install npm:pi-lean-ctx --approve || true

# Configure pi with fornace-llm gateway as custom provider.
# LLM_BASE_URL build arg: docker-DNS name when waynode is co-located with
# fornace-llm (49.12.9.255), or the WireGuard tunnel IP (10.200.0.1) when
# waynode runs on the sandbox host (ffrapposerver).
ARG LLM_BASE_URL=fornace-llm:4000
RUN mkdir -p /root/.pi/agent && echo '{\
  "providers": {\
    "fornace": {\
      "baseUrl": "http://${LLM_BASE_URL}/v1",\
      "api": "openai-completions",\
      "apiKey": "sk-4dea025d8aa9572a2a68b8e4126561519fec29e3cf2fc26f",\
      "compat": {"supportsDeveloperRole": false, "supportsReasoningEffort": false},\
      "models": [\
        {"id": "fornace-fast", "name": "Fornace Fast"},\
        {"id": "fornace-reasoning", "name": "Fornace Reasoning"},\
        {"id": "fornace-max", "name": "Fornace Max"},\
        {"id": "glm-5.2-fast", "name": "GLM 5.2 Fast"},\
        {"id": "glm-5.2-reasoning", "name": "GLM 5.2 Reasoning"},\
        {"id": "qwen-flash", "name": "Qwen Flash"}\
      ]\
    }\
  }\
}' > /root/.pi/agent/models.json

# Data volume
RUN mkdir -p /data/repos
VOLUME /data

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data

EXPOSE 3000

CMD ["node", "server.js"]
