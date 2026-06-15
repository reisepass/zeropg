FROM node:22-slim

WORKDIR /app

# pg_isready for startup probe (Rallly container won't start until this passes)
RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client \
  && rm -rf /var/lib/apt/lists/*

COPY image-package.json package.json
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY dist/server.mjs ./server.mjs
COPY dist/seed.tar.gz ./seed.tar.gz

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080 5432

CMD ["node", "server.mjs"]
