FROM node:22-slim
WORKDIR /app
COPY server.mjs ./server.mjs
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
