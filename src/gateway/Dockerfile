FROM node:22-alpine

WORKDIR /app

COPY src/gateway/package.json ./package.json
RUN npm install --omit=dev --ignore-scripts

COPY src/gateway/index.js ./index.js

ENV NODE_ENV=production
CMD ["node", "index.js"]
