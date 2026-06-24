# The SPLIT FRONTEND: a tiny, dependency-free Node static-page server. No DB, no
# heavy deps, so it cold-starts in well under a second and renders instantly even
# when the capture backend is scaled to zero. It wakes the backend client-side.
FROM node:22-slim
WORKDIR /app
COPY server.mjs ./
ENV NODE_ENV=production
ENV PORT=8080
CMD ["node", "server.mjs"]
