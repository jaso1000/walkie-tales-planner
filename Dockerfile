FROM node:22-alpine
WORKDIR /app
# ffmpeg turns Ogg tracks into M4A when syncing an iPhone, which can't play Ogg
RUN apk add --no-cache ffmpeg
COPY server.js devices.js sync.js names.js tags.js ./
COPY web ./web
ENV PORT=8475 DATA_DIR=/data
EXPOSE 8475
USER node
CMD ["node", "server.js"]
