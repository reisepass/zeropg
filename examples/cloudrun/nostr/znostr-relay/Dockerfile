# znostr-relay: our minimal NIP-01 Nostr relay on zeropg. No Redis.
FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY relay.mjs schema.sql ./
ENV NODE_ENV=production
# PORT is injected by Cloud Run for the ingress container.
CMD ["node", "relay.mjs"]
