FROM node:22.21.1-bookworm-slim@sha256:25b3eb23a00590b7499f2a2ce939322727fcce1b15fdd69754fcd09536a3ae2c
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev && npm cache clean --force
COPY errors.mjs zip.mjs parser.mjs parser-cli.mjs ./
USER 65534:65534
ENTRYPOINT ["node", "--max-old-space-size=384", "/app/parser-cli.mjs"]
