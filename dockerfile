# Dockerfile
# Use an official Node.js runtime as a parent image
FROM node:18-alpine

# Set working directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json (if exists)
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm install --production

# Copy the rest of the application code
COPY . .

# Expose port 3000
EXPOSE 3000

# Environment variable for production
ENV NODE_ENV=production

# Start the server
CMD ["node", "server.js"]
