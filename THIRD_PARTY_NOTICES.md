# Avisos de terceiros

Licenças das dependências relevantes, tiradas dos metadados dos pacotes (`node_modules/<pacote>/package.json`, campo
`license`) nas versões do `bun.lock`. O texto integral de cada licença acompanha o pacote (arquivo `LICENSE` dentro dele).

## Dependências que vão para a imagem de produção

Diretas (`dependencies` do `package.json`; parte delas é empacotada no servidor do Next ou nas CLIs):

| Pacote | Versão | Licença |
|---|---|---|
| next | 16.4.6 | MIT |
| react, react-dom | 19.3.1 | MIT |
| drizzle-orm | 0.45.4 | Apache-2.0 |
| postgres | 4.1.1 | Unlicense |
| zod | 4.6.7 | MIT |
| pdf-lib | 1.17.1 | MIT |
| nodemailer | 10.6.0 | MIT-0 |
| qrcode | 1.5.4 | MIT |
| @modelcontextprotocol/sdk | 1.32.2 | MIT |
| geist (fonte) | 1.9.2 | SIL Open Font License 1.1 |
| @fontsource-variable/inter (fonte) | 5.3.0 | OFL-1.1 |
| echarts (gráficos do painel) | 6.1.0 | Apache-2.0 |
| motion (animações do painel) | 14.14.0 | MIT |
| lucide-react (ícones do painel) | 1.77.0 | ISC |
| @radix-ui/react-tooltip, -dialog, -dropdown-menu | 1.x | MIT |

Logos das plataformas no gráfico "Por origem" (`src/app/admin/brand-icons.ts`): caminhos SVG do Simple Icons 16.38.0,
CC0-1.0 (https://simpleicons.org). As marcas pertencem aos donos; aparecem só para identificar a origem do tráfego.

Componentes copiados para `src/components/arc` (Arc, https://uiarc.dev, só a parte grátis): MIT, Copyright (c) Elia
Kuratli. Itens Arc Pro não entram neste repositório (a licença deles proíbe redistribuir).

Copiadas pelo `output: "standalone"` do Next para `/app/node_modules` da imagem:

| Pacote | Versão | Licença |
|---|---|---|
| @next/env | 16.4.6 | MIT |
| styled-jsx | 5.1.6 | MIT |
| @swc/helpers | 0.5.23 | Apache-2.0 |
| client-only | 0.0.1 | MIT |
| react-is | 19.3.0-canary | MIT |
| @edge-runtime/cookies, ponyfill, primitives | 6.0.0 / 4.0.0 / 6.0.0 | MIT |
| @pdf-lib/standard-fonts, @pdf-lib/upng | 1.0.0 / 1.0.1 | MIT |
| pako | 1.0.11 | MIT AND Zlib |
| regenerator-runtime | 0.13.4 | MIT |
| tslib | 1.14.1 | 0BSD |
| semver | 6.3.2 / 7.8.6 | ISC |
| detect-libc | 2.1.2 | Apache-2.0 |
| sharp, @img/sharp-linux-x64 | 0.35.5 | Apache-2.0 |
| @img/sharp-libvips-linux-x64 | 1.3.4 | LGPL-3.0-or-later (biblioteca compartilhada, sem modificação; usada pelo Next para otimizar imagens) |
| @img/colour | 1.1.0 | MIT |

Imagens base do Docker: `node:22.23-slim` (Node.js, MIT; Debian, várias licenças livres), com o pacote `tini` do
Debian (MIT), `postgres:17.12` (PostgreSQL License), `caddy:2.11` (Apache-2.0). O build usa `oven/bun:1.4.4` (MIT),
que não vai para a imagem final.

## Ferramentas de desenvolvimento (não vão para a imagem)

| Pacote | Licença |
|---|---|
| typescript | Apache-2.0 |
| @playwright/test | Apache-2.0 |
| eslint, eslint-config-next | MIT |
| drizzle-kit | MIT |
| fast-check | MIT |
| happy-dom | MIT |
| Bun | MIT |

## LibreFunnel

A especificação (§8) cita peças do LibreFunnel como referência de estudo, com a regra de manter o aviso MIT
(`Copyright (c) 2026 Genesis Innovation`) em qualquer arquivo copiado ou adaptado. **Nenhum código do LibreFunnel foi
copiado ou adaptado** neste repositório: a busca pelo aviso de copyright e pelo nome do projeto no código
(`git grep -n -i "genesis innovation\|librefunnel"` fora de `docs/superpowers/`) não encontra nada. Se algum arquivo
for adaptado no futuro, ele deve manter no topo o aviso MIT do LibreFunnel e entrar nesta seção.
