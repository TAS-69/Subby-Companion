FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && mkdir data && chown node:node data
COPY src ./src
COPY web ./web
USER node
ENV NODE_ENV=production
ENV SUBBY_HOST=0.0.0.0
EXPOSE 3030
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.SUBBY_PORT||3030)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/main.js"]
