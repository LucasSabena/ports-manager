FROM oven/bun:1.3-alpine

RUN apk add --no-cache docker-cli coreutils lm-sensors iproute2

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --production

COPY . .

ENV NODE_ENV=production
ENV CONFIG_PATH=/app/data/config.json
ENV CLOUDFLARED_CONFIG=/app/cloudflared-config.yml

EXPOSE 3457

CMD ["bun", "run", "src/index.ts"]
