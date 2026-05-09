FROM node:22-slim AS build
WORKDIR /app

# Install deps first (cached as long as package files don't change).
COPY package.json package-lock.json tsconfig.json driver.json ./
RUN npm ci

# Compile sources.
COPY src ./src
RUN npm run build

# Drop dev deps from node_modules so the runtime image is leaner.
RUN npm prune --omit=dev


FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    UC_CONFIG_HOME=/data \
    UC_INTEGRATION_HTTP_PORT=9080
EXPOSE 9080

COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/driver.json ./
COPY --from=build /app/package.json ./

VOLUME ["/data"]
CMD ["node", "dist/driver.js"]
