# ── waynode sandbox base image ──────────────────────────────────────
# This is the image booted inside a microsandbox microVM for each agent run.
# It is NOT the waynode server image — the server runs on the host and spawns
# these sandboxes. This image just needs what `pi` needs to do its job:
# pi itself, git, ripgrep, python3 (for builds), and the fornace LLM provider
# config pointed at the WireGuard tunnel endpoint (10.200.0.1:4000).
#
# Security notes:
#  - No credential is baked into this image. Hosted chat receives only a
#    separately provisioned, model/rate-limited runtime virtual key.
#  - No waynode server code, DB access, or other tenants' repos are present.

FROM node:26-slim

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

WORKDIR /workspace

# Git identity safety net (real attribution comes per-run via GIT_AUTHOR_* env).
RUN git config --global user.name "Waynode" && \
    git config --global user.email "waynode@waynode.fornace.net" && \
    git config --global init.defaultBranch main && \
    git config --global --add safe.directory '*'

# pi CLI + the two extensions waynode relies on.
RUN npm install -g @earendil-works/pi-coding-agent@latest
RUN pi install npm:pi-codex-goal --approve || true
RUN pi install npm:pi-lean-ctx --approve || true

# lean-ctx standalone binary (for pi-lean-ctx extension).
RUN curl -fsSL https://github.com/yvgude/lean-ctx/releases/download/v3.8.11/lean-ctx-x86_64-unknown-linux-musl.tar.gz \
    | tar xzf - -C /tmp && \
    mv /tmp/lean-ctx /usr/local/bin/lean-ctx && chmod +x /usr/local/bin/lean-ctx || \
    echo "lean-ctx install failed, pi-lean-ctx will run without it"

# Fornace LLM provider. Endpoint is the WIREGUARD tunnel address on
# 49.12.9.255 (10.200.0.1:4000) — reachable from the microVM only because the
# VM's NetworkPolicy allows it; it is NOT on the public internet.
RUN mkdir -p /root/.pi/agent && echo '{\
  "providers": {\
    "fornace": {\
      "baseUrl": "http://10.200.0.1:4000/v1",\
      "api": "openai-completions",\
      "apiKey": "$WAYNODE_LLM_KEY",\
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

# Sanity: confirm pi is callable.
RUN pi --version

CMD ["sleep", "infinity"]
