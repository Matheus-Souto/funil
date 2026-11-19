# Funil

Checkout próprio para vender produtos digitais (PDFs) com Pix e cartão, feito para substituir a Cakto num funil de
vendas com página na Cloudflare e anúncios no Meta. O dinheiro vai direto para a conta da loja (chave Pix ou conta
Asaas da loja); a plataforma não intermedia pagamentos.

> Nome do produto ainda a definir. Status: **fase 1 (vendas) concluída**, ainda não publicada em produção.

## O que a fase 1 entrega

- **Checkout** em `/c/<oferta>`, pensado para o celular: Pix manual (valor único por pedido, liberado pelo dono), Pix
  pelo Asaas (liberado sozinho pelo webhook, sempre reconferido na API) e cartão de crédito transparente pelo Asaas
  (dados do cartão nunca gravados nem logados), com order bump.
- **Entrega** por e-mail (SMTP da loja): link de download com validade e limite de downloads, PDF carimbado com os
  dados do comprador; reembolso ou estorno revogam o link.
- **Painel** em `/admin`: visão de vendas, pedidos (liberar, reenviar acesso, reembolsar, exportar CSV), produtos com
  upload do PDF, ofertas, conexões (Pix manual, Asaas, SMTP, Meta) e configurações; papéis dono, admin, suporte e
  tráfego.
- **Rastreamento**: `t.js` na página de vendas (UTMs, `fbclid`, indicação `?ref=`), Meta Pixel e API de Conversões com
  deduplicação por `event_id`.
- **Várias lojas** (`MODE=multi`, por subdomínio) com isolamento por loja no banco (RLS), ou uma loja só
  (`MODE=single`).
- **Instalação** com Docker Compose: app + Postgres 17 + Caddy (HTTPS automático).

## Documentação

- [Instalação em um servidor](docs/instalacao.md): VPS, DNS, primeiro acesso, Asaas, SMTP, Meta, `t.js`, backups,
  atualizações e problemas comuns.
- [Migração da Cakto](docs/migracao-cakto.md): roteiro com compras de teste e troca dos links.
- [Segurança das páginas de pagamento](docs/seguranca-pagamento.md): CSP, inventário de scripts, dados enviados ao Meta.
- Especificação e plano: `docs/superpowers/`.

## Desenvolvimento

Requisitos: [Bun](https://bun.sh) 1.4, Node 22 e Docker.

```sh
bun install
docker compose -f compose.dev.yaml up -d --wait   # Postgres em localhost:5433 e Mailpit em localhost:8025
cp .env.example .env                              # SECRET=$(openssl rand -hex 32) e BASE_URL=http://localhost:3000
bun run migrate
bun run dev                                       # http://localhost:3000/admin
```

- `bun run check`: lint, tipos, higiene dos testes e testes.
- `bash scripts/verify.sh`: verificação completa antes de commit/PR (check, build, app de produção e E2E no celular
  com Playwright; com mudanças de deploy, também o smoke da imagem Docker, `tests/smoke.sh`). Regras em `CLAUDE.md` e
  `REVIEW.md`.

## Licença

[MIT](LICENSE), **provisória: a confirmar pelo dono** antes de publicar o repositório. A AGPL-3.0 é a alternativa para
proteger a versão em nuvem (quem oferecer o software como serviço precisaria publicar as mudanças). Avisos de
terceiros em [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
