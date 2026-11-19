# Caddy com o plugin de DNS da Cloudflare (desafio DNS para o certificado curinga do MODE=multi).
# Só é necessário com deploy/Caddyfile.multi e subdomínios curinga. Ver docs/instalacao.md ("Várias lojas").
FROM caddy:2.11-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/cloudflare

FROM caddy:2.11
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
