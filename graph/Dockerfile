FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
WORKDIR /opt/codegraph
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund \
    && node -e "const p=require('@colbymchenry/codegraph/package.json'); if(p.version!=='1.6.1')process.exit(1); require('@colbymchenry/codegraph')" \
    && npm cache clean --force
COPY runner.mjs ./
ENV CODEGRAPH_TELEMETRY=0 DO_NOT_TRACK=1 CODEGRAPH_NO_UPDATE_CHECK=1 CODEGRAPH_NO_DOWNLOAD=1
USER 10001:10001
ENTRYPOINT ["node", "--liftoff-only", "--disable-warning=ExperimentalWarning", "/opt/codegraph/runner.mjs"]
