FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server ./server
COPY public ./public
ENV PORT=3000 DATA_DIR=/data TRUST_PROXY=1 NODE_ENV=production
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "server/index.js"]
