FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY lib ./lib
COPY games ./games
COPY public ./public
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production PORT=3000 DB_FILE=/data/db.json
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=4s CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "server.js"]
