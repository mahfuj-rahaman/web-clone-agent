FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm install --production

# Copy source
COPY src/ ./src/
COPY .env ./

# Create clones directory
RUN mkdir -p /app/clones

EXPOSE 3000

CMD ["node", "src/server/server.js"]