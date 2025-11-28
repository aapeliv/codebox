# Build stage - build the client
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package.json ./
COPY client/package.json ./client/
COPY server/package.json ./server/

# Install all dependencies
RUN npm install
RUN cd client && npm install
RUN cd server && npm install

# Copy source code
COPY client/ ./client/
COPY server/ ./server/

# Build client
RUN cd client && npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Copy server package files and install production dependencies
COPY server/package.json ./server/
RUN cd server && npm install --production

# Copy server code
COPY server/ ./server/

# Copy built client from builder stage
COPY --from=builder /app/client/dist ./client/dist

# Create data directory for persistence
RUN mkdir -p /app/server/data

# Expose port
EXPOSE 3001

# Set environment variables
ENV NODE_ENV=production

# Run the server
CMD ["node", "server/index.js"]
