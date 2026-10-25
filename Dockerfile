FROM node:24.11.1-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client sshpass ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.js README.md ./
COPY lib ./lib
COPY public ./public
COPY runner ./runner
COPY mcp ./mcp
USER 1000:1000
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8091 DATA_DIR=/data
EXPOSE 8091
CMD ["node", "server.js"]
