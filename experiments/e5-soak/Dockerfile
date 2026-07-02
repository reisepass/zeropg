# E5 soak burst driver: a single dependency-free node script (node 22 built-in
# fetch + crypto). One container execution = one 20-minute traffic slot.
FROM node:22-slim

WORKDIR /app
COPY burst.mjs ./burst.mjs

ENV NODE_ENV=production

CMD ["node", "burst.mjs"]
