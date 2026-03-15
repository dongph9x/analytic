FROM node:20-alpine

WORKDIR /usr/src/app

COPY package.json package-lock.json* ./

# Cài đủ deps (kể cả dev) để build TypeScript
RUN npm install

COPY . .

# Build TypeScript → dist/ (server.ts có /api/health, webhook, ...)
RUN npm run build

# Chỉ giữ production deps để chạy (optional: giảm kích thước image)
RUN npm prune --production

EXPOSE 3004

CMD ["node", "dist/server.js"]

