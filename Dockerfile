# Standalone stdio MCP container for Glama and other containerized clients.
# The daemon remains loopback-only inside this container.
FROM node:22-bookworm-slim AS deps

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential python3 && \
    rm -rf /var/lib/apt/lists/*

# xats-setup bundles daemon code, but its runtime dependencies are installed
# separately because the desktop installer normally installs them per machine.
RUN npm install --global xats-setup@0.3.14 xats-mcp@0.1.4 && \
    cd /usr/local/lib/node_modules/xats-setup/daemon && \
    npm ci --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    XATS_PORT=9100

COPY --from=deps /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY docker/entrypoint.sh /usr/local/bin/xats-container
RUN chmod 0755 /usr/local/bin/xats-container

CMD ["/usr/local/bin/xats-container"]
