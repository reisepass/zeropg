# Ingress container for the stripped Supabase stack on zeropg.
# A tiny Node HTTP server: serves the static shell instantly, mints the anon key,
# and reverse-proxies /rest/v1 -> db sidecar PostgREST and /auth/v1 -> GoTrue
# (Kong-style path layout so stock supabase-js works unmodified). No framework,
# no build step — fast cold start is the entire point.
FROM node:22-slim
WORKDIR /app
COPY server.mjs index.html ./
ENV NODE_ENV=production
CMD ["node", "server.mjs"]
