FROM node:22-slim

WORKDIR /app

# No need for python3/make/g++ anymore (removed better-sqlite3 native deps)
COPY package.json package-lock.json* ./
RUN npm install --production

COPY . .

# Create assets directory (no more local data dir needed — using PostgreSQL)
RUN mkdir -p assets

EXPOSE 3000

CMD ["node", "src/index.js"]
