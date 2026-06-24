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

# Install pi-codex-goal (pi itself is a private CLI — install separately if available)
RUN npm install -g pi-codex-goal@latest 2>/dev/null || echo "pi-codex-goal not available yet, skipping"

# Data volume
RUN mkdir -p /data/repos
VOLUME /data

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data

EXPOSE 3000

CMD ["node", "server.js"]
