# One image for staging and production: nothing is inlined at build time, every value comes from env/ebook.env.
FROM oven/bun:1.3.2-slim
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY migrations ./migrations
ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA NODE_ENV=production PORT=3000
USER bun
EXPOSE 3000
# The probe has its own 3 s budget, above the app's 1 s database ping, and below the 5 s Docker timeout,
# so a slow database reads as unhealthy instead of a hung probe (the fe/bazi HEALTHCHECK lesson).
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:3000/ebook-api/health',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["bun", "run", "src/server.ts"]
