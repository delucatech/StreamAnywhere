# StreamAnywhere resolver + proxy + built client in one container.
# Works on Render / Koyeb / Fly / any Docker host. Node 20 (the code also runs on Node 16).
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json client/
COPY server/package.json server/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
# yt-dlp fallback resolver (optional but cheap)
RUN apk add --no-cache python3 py3-pip && pip3 install --break-system-packages --no-cache-dir yt-dlp
COPY package.json package-lock.json ./
COPY client/package.json client/
COPY server/package.json server/
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/client/dist client/dist
COPY --from=build /app/server/dist server/dist
ENV NODE_ENV=production SERVE_CLIENT=true HOST=0.0.0.0 PORT=8787
EXPOSE 8787
CMD ["node", "server/dist/server/src/index.js"]
