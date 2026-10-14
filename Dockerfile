# ============================================================
# Cardápio Digital SaaS — imagem de produção
# Multi-stage: deps de build enxutas, runtime sem ferramentas.
# ============================================================
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001

# user sem privilégios
RUN addgroup -S cardapio && adduser -S cardapio -G cardapio

COPY --from=build --chown=cardapio:cardapio /app/node_modules ./node_modules
COPY --from=build --chown=cardapio:cardapio /app/package.json ./package.json
COPY --from=build --chown=cardapio:cardapio /app/server.js ./server.js
COPY --from=build --chown=cardapio:cardapio /app/index.html ./index.html
COPY --from=build --chown=cardapio:cardapio /app/404.html ./404.html
COPY --from=build --chown=cardapio:cardapio /app/manifest.json ./manifest.json
COPY --from=build --chown=cardapio:cardapio /app/css ./css
COPY --from=build --chown=cardapio:cardapio /app/js ./js
COPY --from=build --chown=cardapio:cardapio /app/pages ./pages
COPY --from=build --chown=cardapio:cardapio /app/assets ./assets
COPY --from=build --chown=cardapio:cardapio /app/db ./db
COPY --from=build --chown=cardapio:cardapio /app/lib ./lib
COPY --from=build --chown=cardapio:cardapio /app/middleware ./middleware
COPY --from=build --chown=cardapio:cardapio /app/routes ./routes
COPY --from=build --chown=cardapio:cardapio /app/services ./services
COPY --from=build --chown=cardapio:cardapio /app/migrations ./migrations
COPY --from=build --chown=cardapio:cardapio /app/scripts ./scripts

# uploads isolados por tenant (data/tenants/{id}/produtos)
RUN mkdir -p /app/data/tenants && chown -R cardapio:cardapio /app/data
USER cardapio

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# o boot roda as migrations pendentes antes de ouvir a porta
CMD ["node", "server.js"]
