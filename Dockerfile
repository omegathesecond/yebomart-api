FROM node:20-slim AS builder

RUN apt-get update -y && apt-get install -y openssl

WORKDIR /app

COPY package*.json ./

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
