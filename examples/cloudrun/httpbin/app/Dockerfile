# The httpbin + requestbin BACKEND (ingress container). One tiny Node app with a
# single runtime dependency (`pg`). It talks to the zeropg `db` sidecar over
# localhost:5432. No build step, no framework — boots in well under a second.
FROM node:22-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY server.mjs ./

ENV NODE_ENV=production
ENV PORT=8080
# PGHOST/PGPORT default to 127.0.0.1:5432 (the shared-localhost db sidecar).
CMD ["node", "server.mjs"]
