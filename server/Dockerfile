FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

RUN mkdir -p /app/data
RUN chown -R node:node /app/data

USER node
EXPOSE 3000

CMD ["node", "server.js"]
