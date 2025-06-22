# Use an official Node.js 18 runtime as a parent image
FROM node:18-alpine

# Baileys and its dependencies for media require some extra packages
# See: https://github.com/WhiskeySockets/Baileys#requirements
RUN apk add --no-cache \
    g++ \
    make \
    cairo-dev \
    jpeg-dev \
    pango-dev \
    giflib-dev \
    librsvg-dev \
    git

# Set the working directory in the container
WORKDIR /app

# Copy package.json and package-lock.json to leverage Docker cache
COPY package*.json ./

# Install app dependencies
RUN npm install --omit=dev

# Bundle app source
COPY . .

# Your app binds to port 3000, so expose it
EXPOSE 3000

# Define the command to run your app
CMD ["node", "index.js"]