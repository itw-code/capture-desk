# Hosted Capture Desk: one process, no dependencies, no secrets baked in.
# The demo is BYO-credentials: every visitor's sandbox keys arrive at runtime
# through POST /api/session and live only in this process's memory.
#
# Build:  docker build -t capture-desk .
# Run (localhost trial, plain HTTP):
#   docker run --rm -p 8790:8790 -e DESK_INSECURE_LOCAL=1 capture-desk
# Then open http://127.0.0.1:8790/ and connect a sandbox app.
#
# Hosted mode refuses plain HTTP, which is why the trial run above sets
# DESK_INSECURE_LOCAL=1 (session cookie drops Secure, origin check accepts http).
# A real deployment terminates TLS at a proxy you control and sets
# DESK_TRUST_PROXY=1 plus DESK_TRUSTED_PROXIES (defaults to loopback, which
# covers a same-host docker sidecar). Only the proxy's own address is trusted;
# every other peer's forwarding headers are ignored, so it fails closed:
#   docker run --rm -p 127.0.0.1:8790:8790 -e DESK_TRUST_PROXY=1 -e DESK_TRUSTED_PROXIES="<proxy-ip>" capture-desk
#
# node:22-bookworm-slim ships node:sqlite; verified at Node v22.23.4.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    DESK_HOSTED=1 \
    PORT=8790

WORKDIR /app

# No npm install: the server and its ledger use only Node built-ins. Only the
# files the HTTP server needs are copied; the CLI, MCP server and eval stay out.
COPY package.json server.js desk.js store.js ./
COPY public ./public

USER node

EXPOSE 8790

# Liveness only: any non-5xx answer proves the HTTP layer is up. A direct probe is
# plain HTTP, so hosted mode answers 403; that still counts as alive, and the edge
# proxy is what checks real readiness.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8790)+'/api/session').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
