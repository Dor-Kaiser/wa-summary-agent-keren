FROM node:20-slim

RUN apt-get update && apt-get install -y     git     chromium     chromium-sandbox     fonts-freefont-ttf     fonts-noto     libxss1     libnss3     libatk-bridge2.0-0     libgtk-3-0     libgbm1     libasound2     --no-install-recommends     && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV DATA_DIR=/data
ENV PORT=8080

WORKDIR /app
COPY package.json .
RUN npm install
COPY index.js .
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8080
ENTRYPOINT ["/app/entrypoint.sh"]

ENTRYPOINT ["/app/entrypoint.sh"]
