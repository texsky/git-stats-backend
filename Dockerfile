# Use an official Node image with Debian (supports apt-get)
FROM node:22-bullseye

# Install git so we can run git clone commands
RUN apt-get update && apt-get install -y git

# Set working directory inside container
WORKDIR /app

# Copy only package.json and package-lock.json first (for caching)
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy rest of the backend files
COPY . .

# Expose the backend port (9000 in your case)
EXPOSE 9000

# Start the server
CMD ["npm", "start"]
