FROM node:24.11-alpine

WORKDIR /app

# sqlite3 native module build deps (Alpine/musl)
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy application file
COPY server.js ./

# Expose port
EXPOSE 3000

# Run node
CMD ["node", "server.js"]

