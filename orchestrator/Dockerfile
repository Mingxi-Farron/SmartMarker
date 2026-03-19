FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm config set registry https://registry.npmmirror.com
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY src ./src

ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 8080

CMD ["npm", "run", "start"]
