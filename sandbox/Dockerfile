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

FROM node:26.0.0-slim@sha256:ccd1c33b2876c07564b3fae7f6a5815aa42f71163faf07d00a9907e398d48bdc

ARG WAYNODE_REVISION=development
LABEL org.opencontainers.image.revision=$WAYNODE_REVISION

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ripgrep \
    python3 \
    python3-pip \
    python3-setuptools \
    make \
    g++ \
    ca-certificates \
    curl \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*

# The complete orchestrator and its workers/checks run inside this microVM.
# Install the same immutable, locally vendored runtime as the server image.
COPY vendor/hammersmith/hammersmith-0.1.0+86a8308d.tar.gz /tmp/hammersmith.tar.gz
COPY vendor/hammersmith/hammersmith-entry.py /tmp/hammersmith-entry.py
RUN echo "1a8f44f26bf9d7cce0b7191c74fbfe8f2c3a96f7c01c0826c3ffba34964242c1  /tmp/hammersmith.tar.gz" | sha256sum -c - && \
    python3 -m pip install --break-system-packages --no-deps --no-build-isolation /tmp/hammersmith.tar.gz && \
    install -m 0755 /tmp/hammersmith-entry.py /usr/local/bin/hammersmith && \
    test "$(hammersmith --version)" = "hammersmith 0.1.0" && \
    rm -f /tmp/hammersmith.tar.gz /tmp/hammersmith-entry.py

WORKDIR /workspace

# Git identity safety net (real attribution comes per-run via GIT_AUTHOR_* env).
RUN git config --global user.name "Waynode" && \
    git config --global user.email "waynode@waynode.fornace.net" && \
    git config --global init.defaultBranch main && \
    git config --global --add safe.directory '*'

# pi CLI + the two extensions waynode relies on.
RUN npm install -g @earendil-works/pi-coding-agent@0.80.7
RUN pi install npm:pi-codex-goal@0.1.36 --approve
RUN pi install npm:pi-lean-ctx@3.9.9 --approve

# lean-ctx standalone binary (for pi-lean-ctx extension).
ARG LEAN_CTX_VERSION=v3.9.9
ARG LEAN_CTX_SHA256=5e33a5f6214fcffccac38d955c56d7467adfde4455c22dbb16dd37ce05460ba4
RUN curl -fsSL -o /tmp/lean-ctx.tar.gz \
      https://github.com/yvgude/lean-ctx/releases/download/${LEAN_CTX_VERSION}/lean-ctx-x86_64-unknown-linux-musl.tar.gz && \
    echo "${LEAN_CTX_SHA256}  /tmp/lean-ctx.tar.gz" | sha256sum -c - && \
    tar xzf /tmp/lean-ctx.tar.gz -C /tmp && \
    mv /tmp/lean-ctx /usr/local/bin/lean-ctx && chmod +x /usr/local/bin/lean-ctx && \
    lean-ctx --version

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

# Sanity: confirm both hosted execution tools are callable.
RUN pi --version && hammersmith --version

CMD ["sleep", "infinity"]
