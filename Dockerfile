FROM node:22-alpine
WORKDIR /app
COPY server.js ./
COPY web ./web
ENV PORT=8475 DATA_DIR=/data
EXPOSE 8475
USER node
CMD ["node", "server.js"]
