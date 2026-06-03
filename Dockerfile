FROM node:22-slim

WORKDIR /app

# No need for python3/make/g++ anymore (removed better-sqlite3 native deps)
COPY package.json package-lock.json* ./
RUN npm install --production

COPY . .

# v6.1.1: defensively COPY the quiz assets again — this is a no-op when the
# previous `COPY . .` already brought them in, but it gives us a clear build-
# time error if assets/quiz/ is somehow missing (e.g. a stray .dockerignore
# change). It also produces visible build logs of how many PNGs landed inside
# the image, which makes "no photos in Telegram" trivial to debug.
COPY assets/quiz /app/assets/quiz
RUN echo "[build] quiz assets present:" && ls -lah /app/assets/quiz | head -25

# Create assets directory (no more local data dir needed — using PostgreSQL)
RUN mkdir -p assets

EXPOSE 3000

CMD ["node", "src/index.js"]
