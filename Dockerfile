FROM node:20-alpine

# better-sqlite3 requires native compilation
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src/ ./src/
COPY server.js ./

# SQLite data directory — mount a named volume here for persistence
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3001

ENV NODE_ENV=production
ENV DB_PATH=/data/transactions.db
ENV PORT=3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

CMD ["node", "server.js"]
