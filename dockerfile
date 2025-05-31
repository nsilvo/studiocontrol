# Dockerfile
# Use official Node.js 18 LTS
FROM node:18-alpine

# Create app directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies (production only)
RUN npm ci --production

# Copy the rest of the application code
COPY . .

# Expose port 3030
EXPOSE 3030

# Start the server
CMD ["node", "server.js"]