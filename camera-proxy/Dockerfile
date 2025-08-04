FROM node:22-alpine

RUN apk add --no-cache ffmpeg curl

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

RUN mkdir -p /data/streams /data/images

EXPOSE 3000

CMD ["npm", "start"]