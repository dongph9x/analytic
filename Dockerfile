FROM node:20-alpine

WORKDIR /usr/src/app

# Biến môi trường (ví dụ OPENAI_API_KEY) được truyền qua docker-compose env_file, không copy .env vào image.
COPY package.json package-lock.json* ./

RUN npm install --production

COPY . .

EXPOSE 3004

CMD ["npm", "start"]

