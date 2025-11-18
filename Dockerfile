# Use an official Node image with Debian (supports apt-get)
FROM node:22-bullseye

# Install git so we can run git clone commands
RUN apt-get update && apt-get install -y git

# Set working directory inside container
WORKDIR /app

# Copy package.json first for better caching
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of your backend files
COPY . .

# Expose backend port
EXPOSE 9000

# Start the server
CMD ["npm", "start"]
