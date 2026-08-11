FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY migrations ./migrations

ENV NODE_ENV=production
ENV PORT=4100

EXPOSE 4100

CMD ["node", "src/server.js"]
