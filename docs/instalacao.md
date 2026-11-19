# Instalação em um servidor (VPS)

Guia passo a passo para colocar o checkout no ar com Docker. Não precisa saber programar: basta copiar e colar os
comandos no terminal do servidor. Onde aparecer `minhaloja.com.br`, use o seu domínio.

O que sobe: o **app** (checkout, painel e envio dos PDFs), o **Postgres** (banco de dados) e o **Caddy** (recebe as
visitas e cuida do HTTPS sozinho). Tudo definido em `compose.yaml`. Só o Caddy fica exposto na internet (portas 80 e
443); o banco e o app ficam numa rede interna.

## 1. O servidor

- **Mínimo:** 1 vCPU, 1 GB de RAM, 20 GB de disco, Ubuntu 24.04. O app tem teto de 768 MB de memória (orçamento
  abaixo); o Postgres e o Caddy usam pouco (dezenas de MB) com uma loja.
- Crie **2 GB de swap** (a primeira montagem da imagem, `next build`, passa de 1 GB de RAM):

  ```sh
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
  ```

- Instale o Docker (já vem com o `docker compose`):

  ```sh
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker $USER   # saia e entre de novo no SSH depois disso
  ```

- Firewall: libere só SSH (22), HTTP (80) e HTTPS (443, TCP e UDP).

### Orçamento de memória do app (teto de 768 MB)

Medido no smoke de deploy (`tests/smoke.sh`) com um PDF de 46 MB (perto do limite de 50 MB do upload):

| Parte | Memória |
|---|---|
| Servidor Next (Node) ocioso, recém-iniciado | ~150 MB |
| Worker de PDF (um por vez para o app inteiro: carimbo e validação do upload dividem a mesma fila) | heap limitado a 192 MB |
| Buffers do PDF fora do heap do Worker (entrada de até 50 MB + saída carimbada) | ~100 MB |
| Pico medido dos processos no fluxo completo (upload + carimbo de 46 MB) | ~310 MB |
| Pico do container contando o cache de arquivos do Linux (liberável) | 400 a 600 MB |

Um PDF que precise de mais do que o teto do Worker falha sozinho (o dono vê "Não conseguimos processar este PDF") sem
derrubar o app. Um segundo PDF espera na fila (até 20; acima disso "tente em instantes"), nunca roda em paralelo.

## 2. DNS: `checkout.minhaloja.com.br`

O checkout fica num subdomínio do **mesmo domínio raiz** da página de vendas (ex.: página em `minhaloja.com.br`,
checkout em `checkout.minhaloja.com.br`). Assim os cookies do Pixel do Meta (`_fbp`, `_fbc`) valem nos dois e a
atribuição dos anúncios não se perde.

No painel de DNS (ex.: Cloudflare, onde fica a página de vendas), crie um registro:

| Tipo | Nome | Conteúdo | Proxy |
|---|---|---|---|
| A | `checkout` | IP do servidor | **Desligado** (nuvem cinza, "Somente DNS") |

Espere o nome responder com o IP do servidor (`ping checkout.minhaloja.com.br`) **antes** de subir: o Caddy pede o
certificado HTTPS ao Let's Encrypt na primeira subida.

### Proxy da Cloudflare (nuvem laranja): recomendamos deixar desligado

Com o proxy **desligado**, o Caddy emite o próprio certificado e recebe o IP real do comprador. É o caminho testado.

Se quiser o proxy **ligado**, faça tudo isto (senão o cartão e os limites antifraude quebram):

1. SSL/TLS da zona em **Full (strict)** (o Caddy já tem certificado válido; "Flexible" causa redirecionamento infinito).
2. Não use regras que reescrevam o **Host** (Origin Rules, "Host Header Override", Workers que troquem o host). O
   pagamento com cartão confere se a origem do navegador bate com o Host; com o Host reescrito, todo cartão volta
   **403**.
3. IP do comprador: o Caddy passa a ver o IP da Cloudflare. Ensine o Caddy a confiar só na Cloudflare e conte dois
   proxies. Não edite o `deploy/Caddyfile` (ele vem do git e o `git pull` das atualizações conflitaria): copie para
   um arquivo seu, fora do git, e aponte o compose para ele:

   ```sh
   cp deploy/Caddyfile deploy/Caddyfile.local     # deploy/Caddyfile.local está no .gitignore
   echo 'CADDYFILE=Caddyfile.local' >> .env
   ```

   No `deploy/Caddyfile.local`, acrescente no topo (lista atual em <https://www.cloudflare.com/ips/>):

   ```
   {
   	servers {
   		trusted_proxies static 173.245.48.0/20 103.21.244.0/22 ... (todas as faixas IPv4 e IPv6 da Cloudflare)
   	}
   }
   ```

   e no `.env` use `TRUST_PROXY=2`. Sem isso, todos os compradores parecem ter o mesmo IP (o limite por IP bloqueia
   gente honesta e o Asaas recebe um `remoteIp` errado na análise antifraude do cartão).

## 3. Baixar e configurar

```sh
git clone <endereço-do-repositório> funil && cd funil
cp .env.example .env
nano .env
```

Preencha no `.env` (o arquivo explica cada linha):

| Variável | Valor |
|---|---|
| `DOMAIN` | `checkout.minhaloja.com.br` |
| `BASE_URL` | deixe vazia (vira `https://checkout.minhaloja.com.br`) |
| `MODE` | `single` (uma loja) |
| `SECRET` | resultado de `openssl rand -hex 32` (sempre este comando) |
| `POSTGRES_PASSWORD` | resultado de `openssl rand -hex 24` |
| `APP_DB_PASSWORD` | outro resultado de `openssl rand -hex 24` |

- Gere cada valor com o comando e cole sem aspas e sem espaços. A imagem recusa senhas do banco com menos de 16
  caracteres.
- **Guarde o `SECRET` (e uma cópia do `.env`) num gerenciador de senhas ou cofre, NUNCA junto com os backups.** Sem o
  mesmo `SECRET`, as chaves salvas (Asaas, SMTP, Meta) não abrem mais; e quem tiver um backup do banco **mais** o
  `SECRET` consegue abrir todas essas chaves (cobrar e estornar pelo Asaas da loja, mandar e-mail como a loja).
- `POSTGRES_PASSWORD` só vale na primeira subida (quando o banco é criado).

## 4. Subir

```sh
docker compose up -d --build
docker compose ps         # app "healthy", caddy e postgres "running"/"healthy"
```

A primeira vez demora alguns minutos (monta a imagem). A cada início, o app aplica as migrações do banco sozinho
(com o papel dono do Postgres) e depois passa a rodar com o papel `app`, que só enxerga os dados da própria loja; o
servidor em execução nem recebe a senha do papel dono.

Abra `https://checkout.minhaloja.com.br/api/health`: deve aparecer `{"ok":true}`.

Para ver o que está acontecendo: `docker compose logs -f app` (ou `caddy`).

## 5. Primeiro acesso

- **Uma loja (`MODE=single`):** abra `https://checkout.minhaloja.com.br/admin`. Na primeira vez aparece a
  configuração inicial (`/admin/setup`): nome da loja, seu nome, e-mail e senha (mínimo 10 caracteres). Depois disso
  a tela de setup some para sempre e o acesso é por `/admin/login`.
- **Várias lojas (`MODE=multi`):** veja a seção 11.

## 6. Asaas (produção)

No painel: **Conexões → Asaas**.

1. No Asaas (conta de produção), gere a chave de API em **Integrações → Chaves de API**. Copie direto do Asaas e cole
   no campo **Chave de API**; escolha **produção** e clique em **Conectar Asaas** → **Testar e salvar**. A chave é
   testada antes de salvar e nunca mais aparece no painel.
2. O painel mostra a **URL do webhook** e o **token de autenticação** (botão **Mostrar**).
3. No Asaas: **Integrações → Webhooks → Adicionar**:
   - URL: a do painel (`https://checkout.minhaloja.com.br/api/webhooks/asaas/<id-da-loja>`);
   - Token de autenticação: o do painel;
   - Versão da API: v3; tipo de envio: **sequencial**; webhook **ativo** e **fila de sincronização ligada**;
   - Eventos de cobrança (marque pelo menos): `PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED`, `PAYMENT_OVERDUE`,
     `PAYMENT_DELETED`, `PAYMENT_REFUNDED`, `PAYMENT_REFUND_IN_PROGRESS`, `PAYMENT_CHARGEBACK_REQUESTED`,
     `PAYMENT_CHARGEBACK_DISPUTE`, `PAYMENT_AWAITING_CHARGEBACK_REVERSAL`.
4. **Fila pausada:** se o Asaas pausar a fila de webhooks (várias falhas seguidas, por exemplo durante uma
   manutenção ou com o token errado), corrija o problema e depois **reative a fila** em Integrações → Webhooks. O
   Asaas só reenvia os avisos pendentes depois disso. Enquanto isso, pedidos pagos ficam como "aguardando".

Cada aviso do Asaas é conferido na API do Asaas antes de mudar o pedido (um aviso falso não libera nada).

Pix manual (sem Asaas): **Conexões → Pix manual**, com a sua chave Pix, nome do recebedor e cidade. Cada pedido
ganha um valor único (alguns centavos a mais) para você achar no extrato; libere pelo painel só depois de ver o Pix
no extrato do banco, **nunca** por comprovante enviado pelo comprador.

## 7. E-mail (SMTP)

Os PDFs vão por e-mail, pelo SMTP da loja: **Conexões → E-mail (SMTP)**. O painel testa a conexão antes de salvar.

| Serviço | Servidor | Porta | Usuário | Senha |
|---|---|---|---|---|
| Gmail / Google Workspace | `smtp.gmail.com` | 587 | seu e-mail | **senha de app** (Conta Google → Segurança → Verificação em duas etapas → Senhas de app); a senha normal não funciona |
| Brevo | `smtp-relay.brevo.com` | 587 | login SMTP mostrado no Brevo (SMTP e API) | chave SMTP do Brevo |

O remetente precisa ser um endereço que o serviço aceite (no Gmail, o próprio e-mail; no Brevo, um remetente ou
domínio verificado). Para cair menos no spam, configure SPF e DKIM do domínio do remetente conforme o serviço.

## 8. Meta (Pixel e API de Conversões)

No painel: **Conexões → Meta**.

1. **Pixel ID:** no Gerenciador de Eventos, o número do conjunto de dados (pixel). Use **o mesmo Pixel ID que já
   usava** (na Cakto) para não perder o aprendizado das campanhas.
2. **Token da API de Conversões:** Gerenciador de Eventos → seu pixel → Configurações → API de Conversões → Gerar
   token de acesso. É conferido no Meta antes de salvar e nunca volta ao painel.
3. **Código de teste** (opcional): da aba **Testar eventos**. Use só para conferir e **apague depois** (com ele, os
   eventos não contam para as campanhas).
4. **Obrigatório: desligue a "Correspondência avançada automática"** (Automatic Advanced Matching): Gerenciador de
   Eventos → seu pixel → **Configurações** → **Correspondência avançada automática** → desligar. O app já impede a
   coleta automática de campos e cliques na página de pagamento (`autoConfig` desligado), mas esse recurso específico
   é controlado só no Meta: ligado, o Pixel pode ler e-mail e telefone digitados no checkout. Os dados do comprador
   já vão ao Meta pelo servidor, com hash, pela API de Conversões.

Eventos enviados: InitiateCheckout, AddPaymentInfo e Purchase, com o mesmo `event_id` no navegador e no servidor (o
Meta deduplica). Detalhes em `docs/seguranca-pagamento.md`.

## 9. Página de vendas (Cloudflare) com o `t.js`

O `t.js` leva as UTMs, o `fbclid` e a indicação (`?ref=`) da página de vendas para o checkout, para as vendas
aparecerem por origem.

1. No painel: **Configurações → Script da página de vendas → Copiar script**. É uma linha assim:

   ```html
   <script src="https://checkout.minhaloja.com.br/t.js" data-checkout="checkout.minhaloja.com.br" defer></script>
   ```

2. Na página de vendas (Cloudflare Pages: o `index.html` do projeto), cole a linha logo antes de `</body>` e publique
   de novo.
3. Os botões de compra devem apontar para `https://checkout.minhaloja.com.br/c/<endereço-da-oferta>` (o endereço
   aparece no editor da oferta). O script só completa links desse endereço.

## 10. Backups e atualizações

**Backup** (faça antes de toda atualização e regularmente, ex.: todo dia por cron). Os arquivos saem **cifrados** com
o [age](https://age-encryption.org) e vão para fora do servidor. O backup tem dados de compradores e as chaves da loja
(cifradas com o `SECRET`): **backup + `SECRET` = acesso a todas as chaves salvas**. Por isso o `SECRET`/`.env` fica no
gerenciador de senhas e nunca na mesma pasta, disco ou conta de nuvem dos backups.

Uma vez só, no seu computador (não no servidor): `age-keygen -o chave-backup.txt`. Guarde `chave-backup.txt` no
gerenciador de senhas (sem ela os backups não abrem) e copie só a linha `public key: age1...` para o servidor.

```sh
sudo apt-get install -y age
cd ~/funil
CHAVE=age1...   # a chave PÚBLICA
docker compose exec -T postgres pg_dump -U owner -d funil -Fc | age -r "$CHAVE" > banco-$(date +%F).dump.age
docker run --rm -v funil_app-data:/data alpine tar cz -C /data . | age -r "$CHAVE" > arquivos-$(date +%F).tgz.age
```

O primeiro arquivo é o banco; o segundo, os PDFs dos produtos (pasta `DATA_DIR`, volume `funil_app-data`). Copie os
dois para fora do servidor (ex.: `rclone` para um bucket) e apague as cópias antigas do servidor.

**Restaurar** num servidor novo, com o mesmo `SECRET` (tirado do gerenciador de senhas) e a chave privada do age:

```sh
age -d -i chave-backup.txt banco-AAAA-MM-DD.dump.age > banco.dump
age -d -i chave-backup.txt arquivos-AAAA-MM-DD.tgz.age > arquivos.tgz
docker compose up -d postgres
docker compose exec -T postgres pg_restore -U owner -d funil --clean --if-exists --no-privileges < banco.dump
docker run --rm -v funil_app-data:/data -v "$PWD":/backup alpine tar xzf /backup/arquivos.tgz -C /data
docker run --rm -v funil_app-data:/data alpine chown -R 1000:1000 /data
docker compose up -d --build
rm banco.dump arquivos.tgz
```

`--no-privileges` pula as permissões do papel `app` gravadas no dump (sem ele, o `pg_restore` mostra erros de
`GRANT ... TO app` quando o papel ainda não existe no servidor novo; são esperados e inofensivos). O app recria o
papel `app` e as permissões sozinho ao iniciar (migração).

**Atualizar** (faça o backup antes). Uma vez por mês, mesmo sem versão nova do projeto, para receber as correções de
segurança das imagens base (Node, Postgres e Caddy ficam fixados por versão menor, ex.: `postgres:17.12`; o `pull`
traz as correções dessa versão):

```sh
cd ~/funil
git pull
docker compose pull
docker compose build --pull
docker compose up -d
```

As migrações do banco rodam sozinhas no início do app. Confira `docker compose logs app` (deve aparecer
`migrate: ok`) e o `/api/health`. Mudanças de versão menor das imagens (ex.: `postgres:17.13`) chegam pelo `git pull`.

## 11. Várias lojas (`MODE=multi`)

Cada loja fica em `<slug>.PLATFORM_DOMAIN`. Uma loja também pode ter domínio próprio (`store-create ... --domain
loja.com.br`): o app reconhece o domínio, mas o Caddy só atende os nomes listados no Caddyfile (item 3).

1. No `.env`: `MODE=multi`, `PLATFORM_DOMAIN=plataforma.com.br` e `DOMAIN=plataforma.com.br` (ou outro nome do
   painel).
2. Crie cada loja pela linha de comando (a senha temporária do dono aparece uma vez só):

   ```sh
   docker compose exec app store-create --name "Minha Loja" --slug minhaloja --owner-email dono@exemplo.com
   ```

3. HTTPS dos subdomínios e domínios próprios. Duas opções:
   - **Lista fixa (sem plugin):** copie `deploy/Caddyfile` para `deploy/Caddyfile.local` (fora do git), ponha
     `CADDYFILE=Caddyfile.local` no `.env` e, no `Caddyfile.local`, troque a primeira linha por
     `{$DOMAIN}, minhaloja.plataforma.com.br, outraloja.plataforma.com.br, loja.com.br {` (subdomínios e domínios
     próprios das lojas). Depois `docker compose up -d caddy`. Cada nome precisa de um registro DNS apontando para o
     servidor; o Caddy emite um certificado para cada um.
   - **Curinga `*.plataforma.com.br` (opcional, desafio DNS):** o certificado curinga exige um Caddy com o plugin do
     seu DNS. Com Cloudflare: monte a imagem de `deploy/caddy-dns.Dockerfile`, crie um token da Cloudflare com
     permissão *Zone → DNS → Edit*, e num `compose.override.yaml`:

     ```yaml
     services:
       caddy:
         image: funil-caddy-dns
         build: { context: ., dockerfile: deploy/caddy-dns.Dockerfile }
         environment:
           CLOUDFLARE_API_TOKEN: ${CLOUDFLARE_API_TOKEN}
     ```

     No `.env`: `CADDYFILE=Caddyfile.multi` e `CLOUDFLARE_API_TOKEN=...`; no DNS, um registro `*` (curinga) apontando
     para o servidor. Depois `docker compose up -d --build`. Domínios próprios de lojas entram como blocos extras numa
     cópia `deploy/Caddyfile.local` do `Caddyfile.multi` (`loja.com.br { reverse_proxy app:3000 }`).
4. No modo multi, o SMTP de cada loja só aceita servidores públicos nas portas 587, 465, 2525 ou 25.

## 12. Problemas comuns

- **Pagamento com cartão sempre recusado com "Requisição recusada." (HTTP 403):** algo entre o navegador e o app está
  reescrevendo o **Host** (proxy da Cloudflare com regra de Host, outro proxy na frente, `header_up Host` no
  Caddyfile). O Host tem que chegar igual ao endereço do checkout. Compare seu `Caddyfile.local` com o
  `deploy/Caddyfile` original e veja a seção 2.
- **"Use uma conexão segura (HTTPS) para pagar com cartão":** o app não está recebendo o `X-Forwarded-Proto: https`
  do Caddy. Confira `TRUST_PROXY` (1 com o Caddy do compose; 2 com a Cloudflare ligada, seção 2).
- **Comprador vê "Confira o número de WhatsApp" no Pix do Asaas ou no cartão:** o Asaas recusou o celular. Ele exige
  celular brasileiro válido com DDD (11 dígitos, ex.: 11987654321). Peça ao comprador para corrigir; não é erro de
  configuração.
- **O painel não aceita a chave do Asaas ou o token do Meta, mesmo sendo a certa:** quase sempre caractere a mais na
  cópia (espaço, quebra de linha, aspas, caractere invisível vindo de WhatsApp, Word ou bloco de notas). Copie de
  novo direto do site do Asaas / Meta e cole no painel. No Asaas, confira também se o ambiente escolhido (**produção**
  ou sandbox) é o da chave: a chave de um não vale no outro.
- **O app não sobe e o log diz `APP_DB_PASSWORD` ou `POSTGRES_PASSWORD`:** gere com `openssl rand -hex 24` (a imagem
  recusa senhas com menos de 16 caracteres e os valores de desenvolvimento). Trocar `POSTGRES_PASSWORD` depois da
  primeira subida exige trocar também a senha no banco (`ALTER ROLE owner PASSWORD '...'`).
- **O log diz "Variáveis de ambiente inválidas":** a mensagem lista o nome da variável. Corrija no `.env` e rode
  `docker compose up -d` de novo.
- **Certificado HTTPS não sai:** o DNS ainda não aponta para o servidor, as portas 80/443 estão fechadas no firewall
  do provedor, ou o proxy da Cloudflare está ligado em "Flexible". Veja `docker compose logs caddy`.
- **PDF não chega ao comprador:** **Pedidos → abrir o pedido** mostra o estado do envio; o painel avisa quando o SMTP
  falha. Teste o SMTP em Conexões e use **Reenviar acesso** depois de corrigir.

## Sobre a imagem

- `deploy/Dockerfile`: monta com Bun (instalação e `next build`) e roda só com **Node 22** (`node:22.23-slim`), como o
  usuário não-root `node`, com o `tini` como PID 1 (repassa o sinal de parada; o compose dá 30 s para encerrar). O Bun não vai para a imagem final: as duas linhas de comando que rodam no servidor
  (migrações e `store-create`) são empacotadas para Node no build (menos de 1 MB, contra ~107 MB do binário do Bun).
- `deploy/entrypoint.sh`: aplica as migrações com `OWNER_DATABASE_URL` (papel dono, superusuário do Postgres: algumas
  migrações copiam dados entre lojas e precisam passar por cima do isolamento por loja) e inicia o servidor com
  `DATABASE_URL` (papel `app`, sujeito ao isolamento), já sem `OWNER_DATABASE_URL` no ambiente. As migrações podem
  rodar quantas vezes for (a cada início) e são serializadas por uma trava no banco (dois containers subindo juntos
  não aplicam a mesma migration duas vezes).
- Verificação: `tests/smoke.sh` monta a imagem, sobe a pilha inteira com `DOMAIN=localhost` e faz uma compra de ponta
  a ponta (setup, produto com PDF de 46 MB, oferta, Pix manual, liberação, e-mail e download do PDF carimbado),
  medindo o pico de memória do container.
