# syntax=docker/dockerfile:1
# Imagem de produção do app (compose.yaml). Estágios:
#   bun        -> só fornece o binário do Bun para o build;
#   deps       -> Node 22 + Bun com as dependências instaladas (`bun install`);
#   build      -> `next build` (saída standalone) e as CLIs (migrate, store:create) empacotadas para Node com `bun build`;
#   card-build -> `bun run card:build`: o serviço de cartão isolado num arquivo só (dist/card/server.js, sem
#                 node_modules), o formulário do iframe (form.js, form.css) e o sha256 do form.js (vai também para a
#                 imagem do app: o monitor 11.6.1 confere o /form.js servido contra ele);
#   card       -> imagem do serviço de cartão (`target: card` no compose): Node 22 slim, SÓ dist/card, tini, não-root;
#   runtime    -> imagem do app (o último estágio: o padrão sem `--target`): Node 22 slim, SEM Bun, servidor standalone +
#                 CLIs empacotadas. Usuário não-root (`node`).
# Por que sem Bun no runtime: o binário do Bun tem ~107 MB; as duas CLIs empacotadas para Node têm < 1 MB e rodam
# no mesmo Node do app (o app já roda em Node em produção). Ver docs/instalacao.md.
# Versões fixadas por versão menor (recebem correções com `docker compose build --pull`). Atualize mensalmente: veja
# docs/instalacao.md ("Atualizar").
ARG NODE_IMAGE=node:22.23-slim
ARG BUN_IMAGE=oven/bun:1.4.4

FROM ${BUN_IMAGE} AS bun

FROM ${NODE_IMAGE} AS deps
WORKDIR /src
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

FROM deps AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN bun run build
# CLIs para Node. A saída repete a árvore do repositório (cli/src/lib/db/migrate.mjs, cli/scripts/store-create.mjs),
# então os caminhos relativos de migrate.ts continuam valendo: cli/src/lib/db/rls.sql e cli/drizzle/.
RUN bun build src/lib/db/migrate.ts scripts/store-create.ts --target=node --format=esm --root=. \
      --outdir=/cli --entry-naming='[dir]/[name].mjs' \
 && cp src/lib/db/rls.sql /cli/src/lib/db/rls.sql \
 && cp -r drizzle /cli/drizzle

FROM deps AS card-build
COPY . .
RUN bun run card:build

FROM ${NODE_IMAGE} AS card
# Só o bundle do serviço e os dois arquivos do formulário: nada do app (.next, PDF, painel), nada de node_modules.
# tini repassa o SIGTERM ao Node (que espera a cobrança em curso; stop_grace_period no compose) e recolhe órfãos.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    SERVICE=card
WORKDIR /card
COPY --from=card-build /src/dist/card ./
USER node
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=1s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3100/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# Sem core dump mesmo fora do compose (que já fixa core 0): o processo recebe número e CVV.
ENTRYPOINT ["tini", "--", "sh", "-c", "ulimit -c 0 && exec node /card/server.js"]

FROM ${NODE_IMAGE} AS runtime
# tini: PID 1 pequeno (repassa SIGTERM ao Node e recolhe órfãos). Iniciado pelo entrypoint DEPOIS de remover
# OWNER_DATABASE_URL do ambiente (o `init: true` do compose seria um PID 1 com o ambiente completo do container).
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data
# O servidor roda A PARTIR de /app: o Worker de PDF (src/lib/pdf/sandbox.ts) faz require("pdf-lib") relativo ao
# diretório de trabalho, e o pdf-lib fica em /app/node_modules (serverExternalPackages).
WORKDIR /app
# Código do app pertence ao root (só leitura para o usuário do app); gravável só /data e o cache do Next.
COPY --from=build /src/.next/standalone ./
COPY --from=build /src/.next/static ./.next/static
COPY --from=build /src/public ./public
COPY --from=build /cli ./cli
# sha256 do form.js desta mesma revisão (`card:build`): o monitor 11.6.1 exige que o /form.js servido pelo `card` bata.
COPY --from=card-build /src/dist/card/form.js.sha256 ./card-form.sha256
COPY deploy/entrypoint.sh /usr/local/bin/entrypoint
COPY deploy/store-create.sh /usr/local/bin/store-create
RUN chmod 0755 /usr/local/bin/entrypoint /usr/local/bin/store-create \
 && mkdir -p /data /app/.next/cache \
 && chown node:node /data /app/.next/cache
USER node
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --start-interval=1s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["entrypoint"]
CMD ["start"]
