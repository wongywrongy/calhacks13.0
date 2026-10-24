FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY sandbox/src ./sandbox/src
RUN mkdir /results && chown node:node /results
USER node
CMD ["node", "sandbox/src/server.ts"]
