FROM node:22-slim

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY scripts ./scripts
COPY public ./public

RUN mkdir -p /app/data

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
