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
    python3 \
    make \
    g++ \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install server deps
COPY package.json package-lock.json* ./
RUN npm ci || npm install

# Copy server code
COPY lib/ ./lib/
COPY routes/ ./routes/
COPY server.js ./

# Copy built frontend
COPY --from=builder /build/frontend/dist ./frontend/dist

# Install pi CLI + pi-codex-goal extension
RUN npm install -g @earendil-works/pi-coding-agent@latest
RUN pi install npm:pi-codex-goal --approve || true

# Configure pi with fornace-llm gateway as custom provider
RUN mkdir -p /root/.pi/agent && echo '{\
  "providers": {\
    "fornace": {\
      "baseUrl": "http://fornace-llm:4000/v1",\
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
