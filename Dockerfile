FROM node:20-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    chromium \
    libnss3 libatk-bridge2.0-0 libgtk-3-0 libxss1 libasound2 \
    fonts-liberation libappindicator3-1 \
    fonts-noto fonts-noto-core fonts-dejavu-core \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
