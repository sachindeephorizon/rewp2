FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY cluster.ts ./

RUN npx tsc

# Remove devDependencies after build
RUN npm prune --omit=dev

EXPOSE 9001

CMD ["node", "dist/src/index.js"]
