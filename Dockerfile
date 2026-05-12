FROM node:20-slim AS builder

RUN apt-get update -y && apt-get install -y openssl

WORKDIR /app

COPY package*.json ./
# Vendored YeboID JWKS validator (local to this directory). The package.json
# references it as `file:yebo-mcp-server-0.1.0.tgz`, so it must exist in the
# build context BEFORE `npm ci` runs.
COPY yebo-mcp-server-0.1.0.tgz ./yebo-mcp-server-0.1.0.tgz

RUN npm ci

COPY . .

RUN npx prisma generate --schema=./prisma/schema.prisma
RUN npm run build

FROM node:20-slim AS runner

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package*.json ./

ENV NODE_ENV=production

# Cloud Run will set PORT dynamically (default 8080)
EXPOSE 8080

CMD ["npm", "start"]
