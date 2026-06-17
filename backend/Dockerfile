FROM node:20-slim
WORKDIR /app

# install deps first (better layer caching)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# app source
COPY . .

ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
