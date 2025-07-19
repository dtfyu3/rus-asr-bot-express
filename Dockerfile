# Use an official Node.js runtime as a parent image
FROM node:18

# Install ffmpeg, a system dependency for your application
RUN apt-get update && \
    apt-get install -y ffmpeg && \
    rm -rf /var/lib/apt/lists/*

# Set the working directory in the container
WORKDIR /usr/src/app

COPY resolv.conf /etc/resolv.conf

COPY package*.json ./

RUN chown node:node package*.json || true

RUN mkdir -p tmp_audio && chown -R node:node tmp_audio .

USER node

RUN npm install --only=production

# Bundle app source inside Docker image
COPY . .

# Your app binds to port 7860 (or whatever is in your .env for PORT)
# Make sure this matches the PORT your application listens on.
# This EXPOSE instruction is documentation; you still need to map the port when running the container.
EXPOSE 7860

# Define the command to run your app
CMD [ "node", "index.js" ]
