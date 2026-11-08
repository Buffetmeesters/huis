FROM node:24-alpine
WORKDIR /app
COPY server.js ./
COPY public ./public
ENV DATA_DIR=/data
EXPOSE 8080
CMD ["node", "server.js"]
