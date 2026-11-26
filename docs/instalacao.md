# Instalação em um servidor (VPS)

Guia passo a passo para colocar o checkout no ar com Docker. Não precisa saber programar: basta copiar e colar os
comandos no terminal do servidor. Onde aparecer `minhaloja.com.br`, use o seu domínio.

O que sobe: o **app** (checkout, painel e envio dos PDFs), o **Postgres** (banco de dados) e o **Caddy** (recebe as
visitas e cuida do HTTPS sozinho). Tudo definido em `compose.yaml`. Só o Caddy fica exposto na internet (portas 80 e
443); o banco e o app ficam numa rede interna. Opcional: o **card**, serviço separado que recebe o cartão (seção 12).

## 1. O servidor

- **Mínimo:** 1 vCPU, 1 GB de RAM, 20 GB de disco, Ubuntu 24.04. O app tem teto de 768 MB de memória (orçamento
  abaixo); o Postgres e o Caddy usam pouco (dezenas de MB) com uma loja.
- Crie **2 GB de swap** (a primeira montagem da imagem, `next build`, passa de 1 GB de RAM):

  ```sh
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
  ```

  O container do app **não usa esse swap** (`memswap_limit` igual ao `mem_limit` no `compose.yaml`) nem grava core
  dump: o número e o CVV do cartão passam pela memória dele e nunca devem ir para o disco. O swap serve à montagem da
  imagem e aos outros serviços. Se o servidor tiver RAM de sobra (2 GB ou mais), pode desligar o swap depois da
  primeira montagem (`sudo swapoff -a` e apague a linha do `/etc/fstab`). Detalhes em `docs/seguranca-pagamento.md`.

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
| Pico medido dos processos no fluxo completo (upload + carimbo de 46 MB; 3 execuções) | 310 a 415 MB |
| Pico do container contando o cache de arquivos do Linux (liberável; 3 execuções) | 405 a 600 MB |
| Depois do fluxo, ocioso (sem o cache) | 220 a 290 MB |

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

   (Cópia feita antes do cartão isolado? Acrescente no fim dela a linha `import card/*.caddy`; seção 12.)
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
4. **Feche a origem para quem não vem da Cloudflare.** O IP do servidor acaba descoberto (DNS antigo, certificado,
   varredura) e quem acessa direto pula a Cloudflare (e o WAF/limites dela). No firewall do servidor, libere as portas
   80 e 443 só para as faixas da Cloudflare (<https://www.cloudflare.com/ips/>; atualize quando a lista mudar), por
   exemplo com `ufw`:

   ```sh
   for ip in $(curl -s https://www.cloudflare.com/ips-v4) $(curl -s https://www.cloudflare.com/ips-v6); do
     sudo ufw allow from "$ip" to any port 80,443 proto tcp
   done
   sudo ufw deny 80/tcp && sudo ufw deny 443/tcp
   ```

   Atenção: o Docker publica portas por fora do `ufw` (regras próprias no iptables). Confira com
   `curl -m 5 https://<IP-do-servidor>` de uma máquina de fora; se responder, aplique as regras na cadeia `DOCKER-USER`
   ou use o firewall do provedor da VPS (o mais simples). Alternativa: "Authenticated Origin Pulls" da Cloudflare
   (certificado de cliente exigido pelo Caddy).

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
- **Cartão: configure o Cloudflare Turnstile** (`TURNSTILE_SITE_KEY` e `TURNSTILE_SECRET`, as duas juntas; crie o
  widget em <https://dash.cloudflare.com/?to=/:account/turnstile>). Com muitas recusas de cartão em pouco tempo (sinal
  de teste de cartões roubados), a loja passa a pedir a verificação anti-robô a todos. Sem Turnstile, cada IP fica
  limitado a 3 tentativas por hora enquanto durar o alerta. O painel (Conexões) avisa quando há oferta com cartão e o
  Turnstile não está configurado.

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

- **Uma loja (`MODE=single`):** pegue o **código de configuração** no log do app:

  ```sh
  docker compose logs app | grep "configuração inicial"
  ```

  (ou defina o seu em `SETUP_TOKEN` no `.env` antes de subir). Abra `https://checkout.minhaloja.com.br/admin`. Na
  primeira vez aparece a configuração inicial (`/admin/setup`): código de configuração, nome da loja, seu nome, e-mail
  e senha (mínimo 10 caracteres). O código impede que um robô (que descobre domínios novos pelos certificados HTTPS
  emitidos) crie a loja antes de você. Depois disso a tela de setup some para sempre e o acesso é por `/admin/login`.
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

### E-mail pelo Resend

Em vez do SMTP, a loja pode enviar pelo Resend. A plataforma não fornece Resend: cada loja usa a própria conta
(**Conexões → E-mail (Resend)**).

1. **Chave de API:** no Resend, API Keys → Create API Key (só permissão de envio basta). Cole em `Chave de API`.
2. **Domínio do remetente:** verifique o domínio em Domains no Resend e use um remetente desse domínio.
3. **Webhook (entrega e devolução):** em Webhooks no Resend, crie um webhook com os eventos `email.delivered`,
   `email.bounced` e `email.complained`, apontando para a URL mostrada no cartão do painel. Copie o segredo
   (`whsec_…`) e cole em `Segredo do webhook`.
4. **Usar este provedor:** com o SMTP já conectado, salvar o Resend não troca o envio (numa loja sem SMTP, o Resend
   já fica ativo ao salvar). O botão **Usar este provedor** (no cartão do Resend ou do SMTP) passa os e-mails de acesso
   e os avisos de venda a sair pelo provedor escolhido: só um provedor fica ativo; o outro deixa de ser usado.

### Avisos no Telegram

A plataforma não fornece bot: cada loja cria o seu e recebe os avisos num chat ou grupo da equipe
(**Conexões → Avisos no Telegram**).

1. **Criar o bot:** no Telegram, converse com o @BotFather, envie `/newbot` e siga os passos. Copie o token que ele
   entrega.
2. **Adicionar ao grupo:** crie (ou escolha) o grupo da equipe e adicione o bot a ele.
3. **Achar o chat id:** o id de um grupo é um número negativo (supergrupos começam com `-100`; um grupo comum, não, ex.:
   `-4012345678`): para vê-lo, adicione o @RawDataBot ao grupo, copie o id e remova esse bot em seguida. Se o grupo
   virar supergrupo (o Telegram faz isso sozinho em alguns casos, como ao ligar o histórico para novos membros), o id
   muda e é preciso salvar o novo: o painel avisa quando isso acontece. Um canal público também aceita
   `@nomedocanal`; num canal, o bot precisa ser **administrador** para postar.
4. **Colar em Conexões:** informe o token e o chat id, escolha os eventos e salve. O token é conferido no Telegram antes
   de salvar e nunca volta ao painel (só os 4 últimos caracteres).
5. **Enviar teste:** o botão **Enviar teste** manda uma mensagem ao chat. Se o Telegram recusar o token ou não achar o
   chat, o painel diz qual dos dois conferir.

O que vai em cada mensagem (texto puro, uma linha, sem link):

| Evento | Mensagem |
|---|---|
| Venda aprovada (ligado por padrão) | `Venda: <itens> — <valor> — <forma> — pedido #<código>` |
| Pix gerado | `Pix gerado: <itens> — <valor> — pedido #<código>` |
| Cartão recusado | `Cartão recusado: <itens> — <valor> — pedido #<código>` |
| Carrinho abandonado | `Carrinho abandonado (<N> min sem pagamento): <itens> — <valor> — <forma> — pedido #<código>` |
| Abandono antes do pagamento (desligado por padrão) | `Abandono antes do pagamento (<N> min): <itens> — <valor> — contato #<código>` (ver "Abandono antes de comprar") |

`<itens>` é o produto (ou o nome da oferta, com mais de um produto principal), mais o bump quando houver. **Nunca** vão
nome, e-mail, CPF ou telefone do comprador, nem links.

Segurança: o token do bot é segredo. Não cole em chat, ticket ou captura de tela; se vazar, use `/revoke` no
@BotFather e salve o novo token em Conexões. O bot do funil não precisa ser administrador do grupo. Todo membro do
grupo vê os valores e os produtos das vendas: adicione só quem pode ver esses números.

Nesta versão, **abandono** é o pedido criado e não pago dentro do prazo escolhido (de 10 a 1440 minutos; padrão 30):
o aviso só sai se o pedido continuar sem pagamento e o mesmo comprador não tiver pago a mesma oferta depois. No **Pix
manual**, o pedido só conta como pago quando você o libera no painel: pedido pago e ainda não liberado dentro do prazo
aparece como abandono. O abandono antes de o comprador criar o pedido é o evento **Abandono antes do pagamento**, que depende
de a loja ligar a captura de contatos (seção "Abandono antes de comprar").

Se o Telegram passar a recusar os avisos (token revogado, bot removido do grupo), o painel mostra um aviso na tela
inicial: confira o token e o grupo, salve em Conexões e use **Enviar teste**. O aviso some sozinho quando o teste dá
certo ou quando você salva um token ou chat id novos. Falhas temporárias (limite de envios, instabilidade) são tentadas
de novo sozinhas por cerca de 14 horas; depois disso, aquele aviso é descartado. Raramente (queda do servidor logo
depois do envio) um aviso pode chegar duplicado.

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

`--no-privileges` pula as permissões dos papéis `app` e `card` gravadas no dump (sem ele, o `pg_restore` mostra erros
de `GRANT ... TO app` quando o papel ainda não existe no servidor novo). As políticas ligadas a esses papéis não são
puladas: no servidor novo o `pg_restore` mostra erros de `CREATE POLICY ... TO app`/`TO card` ("role does not exist")
e termina com "errors ignored on restore"; são esperados e inofensivos. O app recria os papéis, as permissões e essas
políticas sozinho ao iniciar (migração).

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

   No primeiro login, o painel exige que o dono troque a senha temporária (ela passou pelo terminal do operador).
   Depois, qualquer pessoa troca a própria senha em "Trocar senha" (ícone de cadeado), o que encerra as outras sessões
   dela; o dono encerra as sessões de um membro em **Loja → Equipe**.

3. HTTPS dos subdomínios e domínios próprios. Duas opções:
   - **Lista fixa (sem plugin):** copie `deploy/Caddyfile` para `deploy/Caddyfile.local` (fora do git), ponha
     `CADDYFILE=Caddyfile.local` no `.env` e, no `Caddyfile.local`, troque a primeira linha por
     `{$DOMAIN}, minhaloja.plataforma.com.br, outraloja.plataforma.com.br, loja.com.br {` (subdomínios e domínios
     próprios das lojas). Depois `docker compose up -d --force-recreate caddy` (o Caddyfile é montado como arquivo: só
     recriando o container ele lê a versão editada) e confira cada nome novo com
     `curl -s -o /dev/null -w '%{http_code}\n' https://<nome novo>/api/health` (`200`). Cada nome precisa de um
     registro DNS apontando para o servidor; o Caddy emite um certificado para cada um.
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
     cópia `deploy/Caddyfile.local` do `Caddyfile.multi`, com o mesmo corte da rota antiga do cartão dos outros sites
     (sem ele, uma aba antiga que mande o cartão para `/api/checkout/card` faz os bytes chegarem ao app):

     ```
     loja.com.br {
     	header Strict-Transport-Security "max-age=31536000"
     	encode zstd gzip
     	@legacyCard {
     		path /api/checkout/card
     	}
     	respond @legacyCard 404
     	reverse_proxy app:3000
     }
     ```
   - Nas duas opções, um `Caddyfile.local` copiado antes do cartão isolado precisa da linha `import card/*.caddy` no fim
     para servir o `pagar.` e do bloco `@legacyCard` em cada site do app (seção 12).
4. No modo multi, o SMTP de cada loja só aceita servidores públicos nas portas 587, 465, 2525 ou 25.
5. Para dar (ou trocar) o domínio próprio de uma loja que já existe: `docker compose exec app store-domain --slug
   minhaloja --domain loja.com.br` (`--clear` tira o domínio). Só funciona com `MODE=multi`. O domínio não pode
   terminar em `.PLATFORM_DOMAIN` (subdomínios da plataforma são os slugs) nem ser o `pagar.` dela; o próprio
   `PLATFORM_DOMAIN` é aceito. A mesma regra vale para `store-create --domain`. O comando mostra `Domínio da loja <slug>: <antes> -> <depois>` e grava a troca no
   histórico de auditoria. O Caddy e o DNS seguem o item 3.

### Passar uma instalação `single` para `multi`

Para quem já vende numa instalação `single` (`checkout.minhaloja.com.br`, cartão em
`pagar.checkout.minhaloja.com.br`) e quer abrir uma segunda loja. A loja que já existe continua no mesmo endereço, e o
`CARD_ORIGIN` não muda: use o domínio atual do checkout como `PLATFORM_DOMAIN` (o `pagar.` + `PLATFORM_DOMAIN` dá o
mesmo `pagar.checkout.minhaloja.com.br`) e dê esse mesmo domínio à loja existente. Lojas novas entram com domínio
próprio; subdomínios de `PLATFORM_DOMAIN` ficam para quem usa slugs.

1. **Antes de tudo**, três conferências e o backup:
   - **SMTP** (só se a loja envia pelo SMTP: em **Conexões**, o cartão **E-mail (SMTP)** está com o selo **Ativo**;
     quem envia pelo Resend pula esta conferência): o `multi` só aceita servidor público nas portas 587, 465, 2525 ou
     25 (item 4 acima). Veja se o servidor e a porta do cartão SMTP atendem a isso; se não, ajuste agora.
   - **Só uma loja.** O `slug` dela sai da mesma consulta:

     ```sh
     cd ~/funil
     docker compose exec -T postgres psql -U owner -d funil -c "select slug, domain from store"
     ```

     Deve vir uma linha só. Anote o `slug` (abaixo, `<slug da loja atual>`).
   - **Backup** (seção 10) e conferência de que o dump está inteiro e tem a tabela da loja. A chave privada do age
     fica só no seu computador, nunca no servidor: rode o comando abaixo **no seu computador**. Ele traz o arquivo
     cifrado (gerado em `~/funil`, seção 10), decifra localmente e manda o dump, em fluxo, para o `pg_restore` do
     container do Postgres, que lê o dump **inteiro** (todos os dados, não só o índice) e gera o SQL; o `grep -c`
     conta, nesse SQL, a carga da tabela `store`. Nada é gravado no banco nem no disco do servidor:

     ```sh
     set -o pipefail
     ssh <servidor> 'cat ~/funil/banco-AAAA-MM-DD.dump.age' | age -d -i chave-backup.txt \
       | ssh <servidor> 'cd ~/funil && docker compose exec -T postgres bash -o pipefail -c "pg_restore -f - | grep -c \"^COPY public.store \""' \
       && echo "backup conferido"
     ```

     Rode num `bash` ou `zsh` (o `set -o pipefail` não existe no `sh`) e com a chave SSH carregada no agente
     (`ssh-add`): o comando abre duas conexões ao mesmo tempo e dois pedidos de senha disputariam o terminal.
     Deve terminar com `1` e `backup conferido`. O que vale é o `backup conferido`: num arquivo cortado o `1` pode
     aparecer antes do erro do `pg_restore` (`could not read from input file: end of file`). Qualquer erro (chave
     errada, arquivo cortado ou corrompido, ou `0` para a tabela `store`) termina sem o `backup conferido`: faça outro
     backup e confira de novo antes de seguir.
2. **Domínio da loja atual**, ainda com o `.env` antigo (o `exec` leva o `MODE` e o `PLATFORM_DOMAIN` novos por
   `-e`). Fazer este passo antes de editar o `.env` evita que um `docker compose up` no meio do caminho suba o
   `multi` com a loja sem domínio.

   Antes, **atualize a imagem para esta versão** (seção 10, "Atualizar", com o backup do passo 1 já conferido),
   ainda em `single`: o comando `store-domain` só existe a partir dela. Confira `migrate: ok` em
   `docker compose logs app` e o `/api/health`. Depois:

   ```sh
   docker compose exec -e MODE=multi -e PLATFORM_DOMAIN=checkout.minhaloja.com.br app \
     store-domain --slug <slug da loja atual> --domain checkout.minhaloja.com.br
   ```

   Sem esse passo, o `multi` não reconhece o host e o checkout da loja atual deixaria de abrir.
3. **`.env`:** guarde antes a versão `single`, fora do clone:
   `cp .env ~/funil.env.single && chmod 600 ~/funil.env.single`. Apague essa cópia quando a loja nova estiver
   estável; a versão `single` continua no seu cofre. Depois edite o `.env`: `MODE=multi` e
   `PLATFORM_DOMAIN=checkout.minhaloja.com.br`; mantenha `DOMAIN`, `BASE_URL` e `CARD_ORIGIN` como estão. Atualize
   também a cópia do `.env` no seu cofre.
4. **Reinicie tudo:** `docker compose up -d` (todos os serviços, para o Caddy também pegar o ambiente novo). Confira:
   - `curl -s https://checkout.minhaloja.com.br/api/health`;
   - o checkout de uma oferta da loja atual (`/c/<slug da oferta>`) abre;
   - `curl -s -o /dev/null -w '%{http_code}\n' https://pagar.checkout.minhaloja.com.br/form.js` mostra `200`;
   - o login no painel funciona;
   - o e-mail sai: em **Conexões**, no cartão do provedor de e-mail ativo (selo **Ativo**: **E-mail (SMTP)** ou
     **E-mail (Resend)**), **Enviar teste**, e confira que a mensagem chegou.
5. **Caminho de volta:** `cp ~/funil.env.single .env` e `docker compose up -d`. No `single` o app atende a única loja sem
   olhar o `store.domain`, então o domínio preenchido não atrapalha. **Vale antes de criar a loja nova.** Depois
   dela, o `single` atende só a loja mais antiga: o checkout e o painel da loja nova ficam fora do ar. O webhook do
   Asaas da loja nova, porém, **continua funcionando**: a URL dele usa o `BASE_URL`, e a rota acha a loja pelo id no
   caminho e pelo token, não pelo domínio. Decida o que fazer com isso: desative o segundo webhook no painel do Asaas
   (os pedidos da loja nova param de ser atualizados até você reativá-lo), ou deixe-o ligado e aceite que pagamentos,
   estornos e vencimentos pendentes continuem atualizando os pedidos da loja nova (e disparando as entregas deles)
   enquanto ela está fora do ar.
6. **Loja nova** (domínio próprio):

   ```sh
   docker compose exec app store-create --name "Loja Nova" --slug lojanova --owner-email dono@exemplo.com \
     --domain checkout.nova-loja.com.br
   ```

   - DNS: registro `A` de `checkout.nova-loja.com.br` para o servidor (nuvem cinza, como na seção 2).
   - Caddy: na lista fixa (item 3 acima), `CADDYFILE=Caddyfile.local` no `.env`, e o `Caddyfile.local` precisa listar
     `checkout.minhaloja.com.br` e `checkout.nova-loja.com.br`, com a linha `import card/*.caddy` no fim; depois
     `docker compose up -d --force-recreate caddy` (só recriando o container o Caddy lê o arquivo editado). Confira o
     HTTPS do host novo (com o DNS acima já propagado):
     `curl -s -o /dev/null -w '%{http_code}\n' https://checkout.nova-loja.com.br/api/health` deve mostrar `200`, e
     `curl -s https://checkout.minhaloja.com.br/api/health` continua respondendo.
   - Turnstile (seção 12): acrescente `checkout.nova-loja.com.br` à lista de hostnames do widget.
   - Asaas (seção 6): se a loja nova usar a **mesma** conta do Asaas, crie um segundo webhook com a URL e o token de
     autenticação que o painel da loja nova mostra (cada loja tem o seu `/api/webhooks/asaas/<id-da-loja>`). Um
     pagamento da outra loja que chegue ao webhook errado é ignorado com resposta 200, sem mexer em pedido nem gravar
     dados da cobrança no histórico de auditoria da loja que não é dona dela; não estranhe.

## 12. Cartão (serviço isolado `pagar.`)

O cartão é sempre digitado num formulário (iframe) servido por um serviço pequeno e separado, o container `card`, num
domínio próprio (`pagar.`): o número, a validade e o CVV não passam pelo processo do app (painel, PDF, e-mail, fila).
O E2E de cada versão faz a compra com cartão por esse iframe. **Para vender com cartão, configure esta seção**: sem
ela (sem `CARD_ORIGIN`), a instalação sobe normalmente, mas o cartão fica indisponível: o checkout mostra só Pix (uma
oferta só de cartão abre com o aviso "Pagamento com cartão indisponível agora" e não vende), o editor de oferta não
deixa ligar o cartão e a visão geral do painel avisa que falta configurar o serviço de cartão.

É uma redução de risco, não de escopo PCI: no mesmo servidor, app e `card` dividem host, Docker e Caddy, e o app
continua no escopo (detalhes, o que falta para reduzir o escopo e as regras de firewall e do Postgres que você precisa
aplicar: `docs/seguranca-pagamento.md`, "Cartão isolado"). As chaves abaixo são tão sensíveis quanto o `SECRET`.

### Atualizar para esta versão (quem já vende com cartão)

Nas versões anteriores, o cartão era digitado no próprio checkout (ou no iframe, com `CARD_ISOLATED=1`). Nesta, o
formulário antigo saiu: **sem `CARD_ORIGIN` configurada, o cartão some do checkout na hora da atualização.** Por isso,
ANTES de atualizar (seção 10, "Atualizar"):

- **Já usava `CARD_ISOLATED=1`:** nada a fazer além da atualização. `CARD_ISOLATED` e `COMPOSE_PROFILES=card` deixam
  de ter efeito nesta versão (o `card` sobe sempre), mas **mantenha as duas no `.env`** enquanto houver chance de
  voltar à versão anterior: lá elas ainda decidem tudo, e sem `CARD_ISOLATED=1` o cartão volta a ser digitado no
  checkout e a passar pelo app, sem aviso (veja "Voltar para a versão anterior" nos avisos abaixo).
- **Vendia com cartão no formulário antigo:** faça os passos 1 a 3 da ordem de ativação abaixo (DNS do `pagar.`, as
  variáveis no `.env` e, com `Caddyfile.local`, a linha `import card/*.caddy` e o bloco `@legacyCard`) e só então
  atualize (passo 4). Se atualizar antes, o checkout segue vendendo com Pix e o painel avisa até você configurar.
- **Só vende com Pix:** nada a fazer. O `card` sobe desligado (só responde à verificação de saúde).

**1. DNS.** Um registro a mais, como o do checkout (seção 2), apontando para o mesmo servidor:

| Modo | Nome | Exemplo |
|---|---|---|
| `single` | `pagar.` + o domínio do checkout | `pagar.checkout.minhaloja.com.br` |
| `multi` | `pagar.` + `PLATFORM_DOMAIN` (um só para todas as lojas) | `pagar.plataforma.com.br` |

O Caddy emite o certificado sozinho. No `multi`, o nome `pagar` fica reservado (nenhuma loja pode usar esse slug), e o
curinga `*` do DNS já cobre o `pagar.` (com a lista fixa de lojas, crie o registro).

**Proxy da Cloudflare: o `pagar.` e o checkout precisam do MESMO estado** (os dois com a nuvem laranja ligada ou os
dois desligados). O `TRUST_PROXY` vale para o app e para o `card`: com a nuvem laranja só no `pagar.` e
`TRUST_PROXY=1`, todo comprador aparece com o IP da Cloudflare (os limites por IP viram compartilhados e o Asaas recebe
um `remoteIp` errado). Com a nuvem ligada, siga a seção 2 inteira (`trusted_proxies`, `TRUST_PROXY=2`) e, nos dois
hosts, deixe desligados Rocket Loader, Email Obfuscation, JS Detections/Bot Fight Mode, Zaraz e o Web Analytics
automático: eles injetam scripts na página, a CSP os bloqueia e o monitor semanal passa a avisar toda semana. Com a
nuvem laranja, a Cloudflare termina o TLS do `pagar.` e vê o cartão: ela passa a ser prestadora de serviço no seu
escopo PCI (`docs/seguranca-pagamento.md`).

**Turnstile (seção 3).** O desafio anti-robô aparece no checkout, não no `pagar.` (o formulário do cartão não carrega
nada da Cloudflare): a lista de hostnames do widget no painel da Cloudflare continua com o domínio do checkout (no
`multi`, o `PLATFORM_DOMAIN`, que cobre as lojas em subdomínio, e cada domínio próprio de loja). O `pagar.` não precisa
estar nela. O `card` confere o token e também o host em que o desafio foi resolvido: só vale o do checkout da loja do
pedido. **Chaves de teste da Cloudflare** (as de "sempre passa"): a resposta do siteverify delas não traz o host do
seu checkout, então toda compra com cartão que precisar do desafio é recusada ("Confirme que você não é um robô").
Para testar em homologação, use um widget real com o host da homologação (ex.: `homolog.minhaloja.com.br`) na lista
de hostnames, ou deixe o Turnstile desligado lá (sem `TURNSTILE_SITE_KEY`/`TURNSTILE_SECRET`, o desafio não aparece).

**2. Variáveis no `.env`.** Gere cada chave com o comando ao lado (um valor diferente para cada uma; as três chaves
`SECRET`, `CARD_TICKET_KEY` e `ASAAS_SEAL_KEY` precisam ser diferentes entre si) e guarde-as junto com o `SECRET`, no
gerenciador de senhas, nunca com os backups:

| Variável | Valor |
|---|---|
| `CARD_ORIGIN` | `https://pagar.checkout.minhaloja.com.br` (no `multi`: `https://pagar.plataforma.com.br`) |
| `CARD_TICKET_KEY` | `openssl rand -hex 32` (assina o bilhete de cada pedido; o serviço confere) |
| `ASAAS_SEAL_KEY` | `openssl rand -hex 32` (cifra a chave do Asaas das lojas para o serviço abrir sem o `SECRET`) |
| `CARD_DB_PASSWORD` | `openssl rand -hex 24` (senha do papel `card` do Postgres; a imagem recusa menos de 16 caracteres) |

**3. Ordem de ativação** (faça o backup antes, seção 10):

1. DNS do `pagar.` criado e respondendo (`ping pagar.checkout.minhaloja.com.br` mostra o IP do servidor).
   Planeje também as regras do servidor que o compose não aplica (saída de rede do `card`, entrada no Postgres vinda
   da rede `card` e logs guardados por 12 meses: `docs/seguranca-pagamento.md`, "Cartão isolado").
2. As quatro linhas acima no `.env`, de uma vez. Com a `ASAAS_SEAL_KEY`, o app passa a cifrar a chave do Asaas com
   ela (avisos abaixo).
3. **Se usa `CADDYFILE=Caddyfile.local`** (Cloudflare com proxy, lista fixa de lojas): se a sua cópia ainda não
   termina com a linha abaixo (cópias feitas antes do cartão isolado não têm), acrescente no fim do
   `deploy/Caddyfile.local`:

   ```
   import card/*.caddy
   ```

   Uma vez só: confira antes com `grep -c 'import card/' deploy/Caddyfile.local` (deve mostrar `0` para acrescentar;
   `1` = já está). Sem a linha, o Caddy não serve o `pagar.` (o checkout mostra "Pagamento com cartão indisponível
   agora"); com ela duas vezes, o Caddy não sobe (problemas comuns, seção 14). Confira também que cada site do app na
   sua cópia tem o bloco `@legacyCard` do `deploy/Caddyfile` (ele corta a rota antiga do cartão antes do app):

   ```
   @legacyCard {
   	path /api/checkout/card
   }
   respond @legacyCard 404
   ```
4. `docker compose up -d --build`. O app reinicia, a migração dá login ao papel `card` com a `CARD_DB_PASSWORD` e a
   chave do Asaas de cada loja passa a ser cifrada com a `ASAAS_SEAL_KEY` (log: "conexões Asaas re-seladas"). O
   `card` pode aparecer `unhealthy` por alguns segundos, até o app terminar a migração.
5. `docker compose ps`: `app` e `card` "healthy".
   `curl -s -o /dev/null -w '%{http_code}\n' https://pagar.checkout.minhaloja.com.br/form.js` mostra `200` (use GET,
   como neste comando: o `card` responde 404 a `curl -I`, que manda HEAD).
6. Uma compra de cartão de teste (valor baixo) no celular. Se o formulário do cartão não aparecer em 10 segundos, o
   checkout mostra "Pagamento com cartão indisponível agora" e oferece o Pix: confira o DNS e `docker compose logs card`.

O `card` sobe sempre; sem `CARD_ORIGIN`, fica desligado (só o `/healthz`, sem banco). O Caddy só serve o domínio do
cartão com `CARD_ORIGIN` definida: o compose monta o `deploy/Caddyfile.card` como
`/etc/caddy/card/site.caddy`, que o `import card/*.caddy` do fim do `deploy/Caddyfile` (e do `Caddyfile.multi`) pega;
sem `CARD_ORIGIN`, o glob não acha nada e o Caddy sobe igual. O container `card` fica numa rede só com o Postgres e o
Caddy (não fala com o app direto; só pelo Caddy, como qualquer visitante), sem volume, com raiz só leitura, sem
capabilities, 192 MB de memória e sem core dump.

**Avisos (leia antes de configurar):**

- **A `ASAAS_SEAL_KEY` não pode mudar nem sumir** depois da primeira subida com ela. Sem ela (ou com
  outra), o app e o `card` recusam subir com `ASAAS_SEAL_KEY ausente ou diferente da que selou a conexão Asaas de N
  loja(s); restaure a chave correta`. Restaure o valor do gerenciador de senhas.
- **Parar de vender com cartão:** desligue o cartão em cada oferta (editor da oferta) e, no `.env`, apague
  `CARD_ORIGIN`, `CARD_TICKET_KEY` e `CARD_DB_PASSWORD` (mantenha a `ASAAS_SEAL_KEY`: as conexões Asaas seguem
  cifradas com ela). A `CARD_DB_PASSWORD` precisa sair: enquanto ela estiver no `.env`, a migração devolve o login ao
  papel `card` a cada início do app. Antes, guarde os logs do `card` (recriar o container apaga os logs dele, e o PCI
  pede 12 meses, requisito 10.5.1):

  ```sh
  docker compose logs --no-color --timestamps card > card-$(date +%F).log
  docker compose up -d
  ```

  Guarde o arquivo fora do servidor (com os backups). Com um driver de log persistente no Docker
  (`docs/seguranca-pagamento.md`, "Logs do `card`"), o export é só uma cópia a mais. O `card` volta a subir
  desligado. Tire também o login do papel `card` (a migração não tira sozinha; sem a `CARD_DB_PASSWORD` no `.env`,
  ela também não devolve):
  `docker compose exec -T postgres psql -U owner -d funil -c 'alter role card nologin'`.
- **Voltar para a versão anterior (a do cartão isolado com `CARD_ISOLATED`)** só é seguro com `CARD_ISOLATED=1` e
  `COMPOSE_PROFILES=card` no `.env` (além de `CARD_ORIGIN` e das chaves). Sem `CARD_ISOLATED=1`, aquela versão volta
  ao formulário antigo: o cartão é digitado no checkout e passa pelo processo do app, sem nenhum aviso. Sem
  `COMPOSE_PROFILES=card`, o `card` não sobe lá e o cartão fica indisponível. A chave do Asaas segue abrindo (aquela
  versão abre `a1` com a `ASAAS_SEAL_KEY`).
- **Voltar para uma versão do sistema anterior ao isolamento trava o Asaas das lojas** se as conexões continuarem
  cifradas com a `ASAAS_SEAL_KEY` (a versão antiga não as abre: Pix e cartão do Asaas param). Esta versão cifra de
  novo a cada início do app, então a ordem importa:
  1. com o app desta versão no ar, regrave as conexões Asaas no formato antigo (só mostra contagens, nunca chaves):

     ```sh
     docker compose exec app asaas-unseal
     ```

     A saída aparece **neste terminal** (não em `docker compose logs app`). Se disser que alguma conexão não pôde ser
     regravada, as lojas estão nas linhas logo acima, no mesmo terminal: cole a chave de API do Asaas dessa loja em
     Conexões → Asaas antes de seguir;
  2. logo em seguida, volte a versão (sem reiniciar o app desta versão no meio: se ele reiniciar, rode a CLI de novo).

  Se já voltou sem rodar a CLI: volte para a versão atual, rode a CLI e volte de novo (ou cole a chave de API do Asaas
  de cada loja em Conexões → Asaas).
- **Restaurar um backup** (seção 10) exige o mesmo `SECRET` **e** a mesma `ASAAS_SEAL_KEY`. Além dos erros de
  `CREATE POLICY ... TO card` já descritos (esperados), nada muda: o app recria o papel `card` com a
  `CARD_DB_PASSWORD` ao iniciar.
- **Atualizar** é igual (seção 10): o `docker compose build --pull` monta também a imagem do `card`. Recriar o
  container apaga os logs dele no driver padrão do Docker: veja "Logs do `card`" em `docs/seguranca-pagamento.md`.
- **A rota antiga do cartão** (`/api/checkout/card`) saiu do app e para sempre no Caddy (bloco `@legacyCard`). Num
  `deploy/Caddyfile.local` copiado antes desta versão, copie o bloco do `deploy/Caddyfile` para dentro de cada site do
  app (um bloco antigo com a linha `expression ... CARD_ISOLATED ...` deixa de valer: tire essa linha); sem ele, o app
  responde 404 sem ler o corpo, mas os bytes chegam ao processo dele.

## 13. Agentes de IA (MCP)

O painel deixa um agente de IA (Claude, por exemplo) consultar a loja pelo protocolo MCP, sem nunca receber dado
pessoal de comprador. O agente consulta a loja na hora; o que altera algo sensível (reembolso, chaves, preços, apagar
produto) vira um **pedido de aprovação** que alguém da equipe confirma no painel antes de qualquer coisa acontecer.

**Criar o token.** No painel: **Loja → Agentes (MCP)** (só quem gerencia a equipe, o dono). Dê um nome, escolha o
papel e clique em **Criar token**. O token (`fnl_...`) aparece **uma única vez**, num quadro com o botão Copiar:
guarde-o agora (cofre de senhas ou o segredo do cliente MCP). Se perder, revogue e crie outro. **Nunca cole o token em
repositório, chat ou ticket; se vazar, revogue na hora.**

**Configurar o cliente MCP.** O endereço é `<BASE_URL>/api/mcp` (por exemplo `https://checkout.minhaloja.com.br/api/mcp`;
o painel mostra o endereço certo ao criar o token) e a autenticação é o cabeçalho `Authorization: Bearer <token>`.
O cabeçalho `Accept: application/json, text/event-stream` é obrigatório (os clientes MCP já o mandam; num `curl` feito à
mão, sem ele, o servidor recusa a requisição). Em um cliente MCP genérico (HTTP), a configuração fica assim:

```json
{
  "mcpServers": {
    "minha-loja": {
      "url": "https://checkout.minhaloja.com.br/api/mcp",
      "headers": { "Authorization": "Bearer COLE_O_TOKEN_AQUI" }
    }
  }
}
```

O nome do bloco e o formato exato do arquivo variam de cliente para cliente; o que importa é a URL e o cabeçalho.
Token ausente, errado ou revogado dá sempre o mesmo erro 401, sem dizer qual foi o caso.

**Datas e prazos.** Períodos (relatório de vendas pagas e métricas) vão em ISO 8601 com fuso, por exemplo
`2026-10-21T00:00:00-03:00`. No relatório de vendas pagas, uma data sem hora (`2026-10-21`) vale como meia-noite de São
Paulo.

**O que cada papel vê:**

| Papel | Acesso |
| --- | --- |
| Leitor | lê produtos, ofertas, métricas e o relatório de vendas pagas |
| Tráfego | Leitor + avisos da loja, estado das conexões (sem chaves) e configurações |
| Suporte | consulta pedidos (comprador mascarado), produtos, ofertas e o relatório de vendas pagas |
| Admin | consulta tudo que o MCP oferece e pede as ações do Admin pela fila |
| Dono | igual ao Admin por enquanto; prefira Admin |

Comece pelo menor papel que resolve o que o agente precisa (Leitor, na dúvida). O papel do token também limita o que
ele pode pedir pela fila: só as ações que o próprio papel teria no painel.

**Ferramentas que exigem aprovação.** No cliente MCP, a descrição dessas ferramentas começa com
`[Exige aprovação no painel]`. Chamá-las **não executa nada**: cria um pedido pendente e o agente recebe só o estado
dele. Para acompanhar, o agente usa a ferramenta `approvals_status` (um pedido pelo id, ou os 20 mais recentes), que
mostra estado, datas, ferramenta, o id do recurso criado (quando houver) e o erro, se houver; nunca o resumo do pedido
nem quem decidiu. As ferramentas sem a marca (consultas, `products_update`, reenvio de acesso e "Enviar teste" das
conexões) executam na hora, com os limites abaixo.

**Aprovar no painel.** Em **Loja → Aprovações** (o item mostra um selo com o número de pedidos pendentes que você pode
decidir). Cada pedido mostra o agente (nome do token e papel), a ação, o que será feito, avisos e quando expira. Produto
aparece com nome, arquivo, tamanho, data de envio e o começo do id (e o selo "enviado pelo agente" quando veio de um
link de upload); oferta, com nome, endereço `/c/...` e o começo do id. Se o nome de um produto ou oferta mudou depois do
pedido, a fila mostra o nome atual e um aviso. Quem não pode decidir um pedido vê só a ação, o agente e as datas. **Aprovar e
executar** roda a ação agora, em nome de quem aprovou, e **Recusar** descarta o pedido. Quem decide: qualquer membro
com a permissão da ação pedida (dono, administrador, atendimento ou tráfego, conforme a ação), inclusive quem criou o
token. Chaves e senhas aparecem só pelos 4 últimos caracteres (a chave Pix aparece inteira, para conferir o destino
do dinheiro). Um pedido vale por **7 dias**; depois disso expira e o agente precisa pedir de novo. Se a ação falhar ao
executar, o pedido fica como "Falhou" com o erro e **não é repetido**. Pedido recusado, expirado ou cancelado (o token
foi revogado) também ficam no histórico (os 50 últimos).

**Enviar PDF de produto.** O agente chama `products_createUploadLink` (nome do produto e do arquivo) e recebe uma URL
de uso único, válida por **15 minutos**. Em seguida faz um `PUT` do arquivo nessa URL com
`Content-Type: application/pdf` (até **50 MB**). O produto é criado quando o PDF chega. A URL é a única credencial do
envio: trate-a como segredo. A chave vai no caminho da URL (`/api/mcp/upload/<chave>`): **não habilite log de URL** em
proxy ou CDN para `/api/mcp/upload/`. Ela vale 15 minutos e é de uso único. PDF inválido devolve o erro e o link segue
valendo, até 5 tentativas (cada envio gasta uma, menos quando o servidor está ocupado processando outro PDF). Um envio
por link de cada vez e até 2 envios ao mesmo tempo no servidor; acima disso, a resposta é 429 com `Retry-After`. Cada
loja pode ter 10 links abertos e cada token pode criar 20 por hora.

**Limites para o agente (só valem para token; o painel não tem limite).** Pedidos de aprovação: 30 por token por hora,
50 pendentes por loja, entrada de até 16 KB; pedir de novo o mesmo pedido pendente devolve o existente. Reenvio de
acesso (`orders_resend`): 1 por pedido por hora, 3 por pedido em 24 horas e 20 por loja por hora; o e-mail sempre vai
ao endereço do pedido. "Enviar teste" das conexões: 5 por hora por loja; o teste de e-mail vai sempre para o e-mail
de avisos da loja (sem ele, o teste é recusado). `products_update` (renomear produto ou arquivo) não tem limite
próprio: fica na auditoria e no limite geral de 120 requisições por minuto do token.

**O que nunca sai pelo MCP, em nenhum papel:**

- Dado pessoal do comprador: nome, e-mail, telefone e CPF saem mascarados (`M***`, `m***@gmail.com`,
  `(**) *****-1234`, `***.***.***-12`) ou não saem; o domínio do e-mail só aparece se for de um provedor comum (Gmail,
  Hotmail, Outlook, Yahoo, iCloud, UOL, BOL, Terra, iG...): os outros saem como `m***@***`. Não há busca por e-mail
  ou nome, nem exportação de pedidos (CSV). IP, user agent e e-mails da equipe também não saem.
- Origem (UTM) e indicação (`ref`) só saem se parecerem nome de campanha; com cara de e-mail, endereço, telefone ou
  frase longa, saem como `(oculto)`.
- Ações sensíveis sem aprovação: o agente nunca as executa por conta própria; elas só rodam depois de aprovadas no
  painel por alguém da equipe.
- Segredos enviados em um pedido (chaves, senhas, tokens): ficam guardados só selados até a decisão, são apagados ao
  aprovar, recusar, expirar ou cancelar, e nunca voltam em nenhuma resposta, log ou auditoria.
- Nunca pelo MCP, nem com aprovação: senha e conta, equipe e criação ou revogação de tokens, aprovar ou recusar pedidos
  (só gente, no painel), exportar pedidos (CSV com dados do comprador) e criar produto com os bytes do arquivo (o
  caminho do agente é o link de upload).

**Revogar.** Em **Agentes (MCP)**, clique em **Revogar** ao lado do token e confirme. O agente perde o acesso na hora.
O token revogado continua na lista, marcado como revogado, para o histórico. Os pedidos pendentes dele são cancelados.

**Quem sai da equipe.** Remover alguém da equipe, a pessoa sair da loja ou um dono deixar de ser dono revoga na hora
os tokens que ela criou nesta loja (o painel avisa quantos antes de confirmar). Crie outros, se ainda forem
necessários.

**Em produção, confira o `TRUST_PROXY`** (seção 2). O MCP limita as requisições por IP (300 por minuto) e as
tentativas com token inválido por IP (30 por minuto). Com `TRUST_PROXY` errado, todo mundo parece ter o mesmo IP: o
limite bloqueia agentes legítimos junto com quem erra. Com `TRUST_PROXY=0`, o IP é desconhecido: o limite por IP não
vale e as falhas de autenticação caem num balde único para o servidor todo. Além disso, cada token tem o limite próprio
de 120 requisições por minuto e de 2 requisições ao mesmo tempo (a terceira simultânea recebe 429 e pode tentar de novo
em 5 segundos); uma consulta que passe de 5 segundos no banco é cortada e volta como erro.

## Equipe e convites

No painel, **Loja → Equipe** mostra quem acessa o painel da loja e os convites pendentes. Só o dono gere a equipe.

**Exige o e-mail da loja.** O convite sai pelo e-mail conectado em **Conexões** (SMTP ou Resend, seção 7). Sem ele, o
botão "Convidar pessoa" fica desabilitado, com um aviso e o link para Conexões. Não existe "copiar link": o link só vai
para o e-mail convidado, assim ninguém aceita no lugar da pessoa.

**Papéis.** Um convite dá um destes papéis (nunca o de dono):

| Papel | Pode | Não pode |
|---|---|---|
| Administrador | Tudo, menos equipe e conexões | Convidar, trocar papel, remover, tokens MCP |
| Atendimento | Pedidos (ver e reenviar), contatos, catálogo só leitura, aprovar pela fila | Métricas, reembolso, liberar Pix, exportar, conexões |
| Tráfego | Métricas, relatório de vendas sem comprador, Pixel das ofertas, catálogo só leitura | Pedidos com dados do comprador, contatos, conexões |

**Validade e limites.** O link vale 7 dias e só uma vez. "Reenviar" manda um link novo e o anterior deixa de valer na
hora; espere 2 minutos entre um reenvio e outro, e cada convite sai no máximo 5 vezes. "Revogar" mata o link. Por loja:
30 e-mails de convite por dia, 20 convites pendentes e 50 pessoas (membros mais convites pendentes). Se o e-mail não
sair, o convite aparece como "Não enviado", com o motivo: confira Conexões e clique em Reenviar.

**Aceitar.** O link abre `/admin/convite/<token>` no endereço da loja. Quem ainda não tem conta escolhe nome e senha (o
e-mail é o do convite e não muda). Quem já tem conta na plataforma (outra loja, no `MODE=multi`) entra com a própria
senha. Não há recuperação de senha: quem esqueceu fala com quem convidou. Depois de 10 tentativas em 15 minutos (por IP
ou por convite), o aceite espera alguns minutos; a senha errada conta também no bloqueio do login.

**Gerir.** Em cada pessoa: "Trocar papel", "Encerrar sessões" e "Remover da equipe". A troca de papel vale no próximo
clique, sem derrubar a sessão. Remover apaga o acesso e as sessões da pessoa nesta loja e revoga os tokens MCP que ela
criou aqui; a conta continua existindo. Na sua linha ficam "Deixar de ser dono" e "Sair da loja". Um dono não muda o
papel nem remove outro dono, e a loja nunca fica sem dono.

**Senha para dar Dono ou Administrador.** Promover alguém a Dono ou Administrador, e convidar como Administrador, pede a
sua senha: uma sessão roubada sozinha não cria um dono, que outro dono não consegue remover. Depois de 5 senhas erradas
em 15 minutos (contando a troca de senha), espere. Rebaixar e trocar entre Atendimento e Tráfego não pedem.

**Transferir a loja.** Troque o papel de quem vai assumir para **Dono** e depois, na sua linha, clique em "Deixar de ser
dono" (ou "Sair da loja"). Os tokens MCP que você criou são revogados nesse passo.

**Várias lojas.** No `MODE=multi`, quem está em mais de uma loja vê "Suas lojas" no rodapé do menu (e no "Mais", no
celular). Cada loja tem a própria sessão: o link abre o painel da outra loja, que pede a senha (a mesma conta).

**Proxy e CDN: não registre a URL de `/admin/convite/`.** O token do convite vai no caminho da URL, como em `/sair/` e
`/api/mcp/upload/`: desligue o log de URL para `/admin/convite/` no proxy ou CDN. A página já manda
`Referrer-Policy: no-referrer` e `Cache-Control: no-store`, e o app nunca grava o token, o link nem o e-mail convidado
no log ou na auditoria.

## Abandono antes de comprar

Muita gente digita o e-mail no checkout e sai sem criar o pedido. Com esta opção, a loja guarda o **e-mail e o celular**
dessa pessoa por até 30 dias, para chamá-la à mão (copiar o e-mail, abrir o WhatsApp) e lembrá-la da compra. O lembrete
automático por e-mail é opcional e tem seção própria (**Recuperação de vendas por e-mail**, abaixo); sem ele, a loja
decide quem contatar.

Isto **não é parecer jurídico**: é o desenho técnico e um roteiro. A loja é a **controladora** dos dados (quem decide
para que e por quanto tempo guardar) e responde por eles; confirme com seu advogado ou encarregado de dados.

**Como ligar.** Vem **desligado**. Em **Configurações**, preencha **E-mail para pedidos de privacidade** (público: ele
aparece no aviso do checkout e é por onde o titular pede acesso ou exclusão) e marque **Guardar o contato de quem não
finaliza a compra**. Sem o e-mail de privacidade, o painel não deixa ligar. Ao desligar, o checkout para de capturar na
hora; os contatos já guardados seguem até os 30 dias (ou até alguém excluí-los).

**O que é guardado.** Só e-mail e celular, com a oferta e o horário. Nunca nome, CPF, IP nem navegador. A captura
acontece quando a pessoa sai do campo de e-mail (e, depois, do de celular) com um valor válido, e só se a pessoa não
tiver tocado em **Não salvar meus dados**.

**O aviso no checkout.** Fica sempre visível, embaixo do campo de e-mail, antes de qualquer coleta:

> A {loja} guarda seu e-mail e celular por até 30 dias para falar com você se a compra não for concluída.
> **Não salvar meus dados** · **Saiba mais**

O **Saiba mais** abre ali mesmo:

> **Quem trata:** {loja}. **Para quê:** só para lembrar você desta compra; seus dados não são vendidos nem
> compartilhados. **Base legal:** legítimo interesse (LGPD, art. 7º, IX). **Por quanto tempo:** até 30 dias; se você
> concluir a compra, valem os dados do pedido e este registro perde o contato na hora. **Seus direitos:** peça acesso
> ou exclusão a qualquer momento por {e-mail de privacidade}, ou toque em "Não salvar meus dados".

**Não salvar meus dados** para a coleta e apaga: o que foi guardado **nesta visita** e, se o e-mail digitado no campo
for válido, os contatos **ainda abertos** (ou contatados) da loja com aquele e-mail, de visitas anteriores. A resposta é
sempre a mesma (não revela se havia algo guardado). A escolha vale **para este navegador**: ao voltar ao checkout nele, a
página já abre sem capturar. Contato guardado em outro navegador, com outro e-mail, ou que já virou pedido, só pelo
**e-mail de privacidade** (a loja usa **Excluir todos deste e-mail** em **Contatos**). O aviso passa a dizer "Pronto:
seus dados não serão guardados antes da compra."

**Base legal: legítimo interesse (LGPD, art. 7º, IX).** Em vez de pedir consentimento, a loja se apoia no legítimo
interesse de lembrar quem já demonstrou interesse na compra. Esse caminho exige que a loja **registre por escrito** o
teste de balanceamento (avaliação de que o interesse da loja não atropela os direitos do titular). Modelo curto para
copiar e adaptar:

| Pergunta | Resposta (adapte à sua loja) |
|---|---|
| **Finalidade** | Lembrar, uma vez (à mão ou pelo lembrete automático por e-mail, se ligado), quem começou o checkout de um produto da loja e não concluiu a compra. |
| **Necessidade** | Só e-mail e celular, que a própria pessoa digitou no checkout. Nada além disso é coletado, e nada é comprado de terceiros. |
| **Expectativa do titular** | Quem preenche o checkout espera ser lembrado da compra. O aviso aparece antes da coleta e diz quem guarda, para quê e por quanto tempo. |
| **Salvaguardas** | Aviso prévio e visível; coleta mínima; apagado em 30 dias; botão **Não salvar meus dados** (para a coleta neste navegador e apaga o que foi guardado nesta visita e o que estiver aberto com o e-mail digitado); exclusão por pedido no painel; contato apaga-se na hora quando a pessoa compra; acesso restrito (dono, admin e suporte). |
| **Conclusão** | O interesse da loja é legítimo e proporcional; o impacto sobre o titular é baixo. Data e responsável pelo registro: ______. |

Guarde esse registro junto com os documentos de privacidade da loja.

**Prazo.** Todo contato é apagado 30 dias depois da captura, esteja ele aberto, contatado ou convertido (a rotina roda
de hora em hora; vencido, ele já some do painel e não gera aviso antes disso). Se a pessoa **compra** (cria o pedido), o
contato vira "Comprou", perde e-mail e celular na hora e passa a apontar para o pedido; o registro some com os 30 dias.
Até vencer, o contato convertido guarda só um **hash** do e-mail (um resumo do e-mail, não o e-mail em si; quem já conhece o e-mail consegue confirmar que ele está ali), usado apenas para
não avisar como abandono quem comprou e para atender o pedido de exclusão (**Excluir todos deste e-mail**).

**Onde ver e agir.** No painel, **Contatos** (dono, admin e suporte): filtro por status (Abertos, Contatados, Compraram),
busca pelo código do contato ou pelo e-mail exato, botão para copiar o e-mail, link do WhatsApp (abre o número da pessoa,
sem texto pronto), **Marcar como contatado** e **Excluir**. Para um pedido do titular ("apaguem meus dados"), use
**Excluir todos deste e-mail** no pé da página: apaga todos os contatos da loja com aquele e-mail. A visão geral mostra
os números **Contatos capturados** e **Viraram pedido** do período. Como os contatos somem com 30 dias, esses números
cobrem só os últimos 30 dias: no período de 30 dias eles aparecem sem a comparação com os 30 dias anteriores (que já
foram apagados). Tráfego não vê esta página.

**Telegram.** O evento **Abandono antes do pagamento** (caixa própria, desligada por padrão, mesmo prazo do "Carrinho
abandonado") manda só a oferta, o valor e o código do contato, por exemplo
`Abandono antes do pagamento (30 min): Almanaque Bíblico Kids — R$ 9,90 — contato #3FA91C`. Nunca vão e-mail, celular
nem link. Para achar a pessoa, busque o código em **Contatos**. Sai no máximo um aviso por contato, e há um teto de 30
avisos por hora por loja (o resto fica só no painel).

**Agentes de IA (MCP).** O MCP **não vê contatos**: nenhuma ferramenta lista, lê ou apaga e-mail ou celular, em nenhum
papel. A única coisa que ele recebe são dois **números** em `metrics.summary`: `leads` (contatos capturados no período) e
`leadsConverted` (quantos viraram pedido), que cobrem só os últimos 30 dias (a retenção dos contatos).

**Proteção contra abuso.** A captura tem limites por IP e por loja (e o **Não salvar meus dados**, por IP e por
visita); passou do limite, o pedido é ignorado em silêncio (o comprador nunca vê erro). Sem a recuperação por e-mail
ligada, um contato falso só causa efeito se a loja o contatar à mão: confira antes de escrever para alguém. Com ela
ligada, valem os limites por endereço da seção seguinte.

## Recuperação de vendas por e-mail

A loja pode mandar **um** lembrete automático por e-mail, pelo próprio provedor de e-mail (SMTP ou Resend, seção 7), a
quem começou a comprar e não pagou. Todo lembrete tem um link para a pessoa não receber mais. Isto **não é parecer
jurídico** (veja **Base legal**, abaixo).

**Como ligar.** Vem **desligado**. Em **Configurações**, marque **Mandar um lembrete por e-mail para quem não concluiu a
compra**. Só liga com o e-mail da loja conectado (o provedor ativo em **Conexões** tem conexão salva); sem ele o painel
avisa "Conecte o e-mail da loja em Conexões antes de ligar.". Embaixo, uma caixa por caso, que já vêm marcadas:
**Digitou o e-mail e saiu antes do pedido** (precisa da captura de contato ligada, seção anterior), **Pix gerado e não
pago** e **Cartão recusado**. Pelo MCP, mudar as configurações continua passando pela fila de aprovação. Ao ligar, nada
sai para abandonos antigos: só entram casos das últimas 6 horas.

**Os três casos e os prazos.** Uma varredura roda a cada 5 minutos e olha só o que foi criado (ou recusado) nas últimas
6 horas. Worker parado por mais de 6 horas perde esses lembretes; nunca sai e-mail em massa depois de uma queda.

| Caso | Quando sai | Para onde o botão leva |
|---|---|---|
| Contato (digitou o e-mail e saiu antes do pedido) | 60 min depois da captura, se o contato ainda estiver aberto | `/c/<oferta>?utm_source=recuperacao&utm_medium=email&utm_campaign=contato` |
| Pix gerado e não pago | 30 min depois de gerado, só se faltar pelo menos 1 hora para o Pix vencer | `/o/<pedido>` (o Pix do pedido) |
| Cartão recusado (pedido ainda pendente com pelo menos uma recusa) | 30 min depois da 1ª recusa | `/c/<oferta>?utm_source=recuperacao&utm_medium=email&utm_campaign=cartao` |

Um lembrete por contato ou pedido. Só **endereços simples** recebem lembrete (letras, números e `. _ % + -` antes do
`@`, domínio com ponto): endereço com comentário entre parênteses, vírgula, ponto e vírgula, aspas, colchetes, `<>` ou
espaço é pulado. Por endereço, na loja: no máximo **1 lembrete a cada 24 horas e 3 em 30 dias**, somando os três casos.
O limite vale para a **caixa de entrada**: variantes com `+` (`ana+promo@exemplo.com`) e, no Gmail, com pontos
(`a.na@gmail.com`, também `@googlemail.com`) contam como o mesmo endereço. Não sai para quem já comprou a mesma oferta (pago, contestado ou reembolsado) nos últimos 30
dias, nem para um pedido mais antigo quando o mesmo cliente tem um mais novo na mesma oferta (o lembrete vai para o mais
novo). Quem digitou o e-mail e gerou o Pix recebe só o do Pix (o pedido converte o contato na hora). Teto da loja: 60
lembretes por hora, dentro deles no máximo 10 do caso cartão; o excedente fica para a próxima varredura, ainda dentro
das 6 horas. Antes de enviar, o app confere tudo de novo: se a pessoa pagou, descadastrou ou o contato foi apagado
nesse meio-tempo, o lembrete não sai. **Oferta desativada:** contato e cartão só recebem lembrete com a oferta ativa,
porque o botão leva ao checkout dela (a varredura nem os seleciona, e o envio confere de novo); o do Pix sai mesmo com
a oferta desativada, porque a página do Pix (`/o/<pedido>`) continua funcionando. Os links nunca levam e-mail nem nome
(o checkout não vem preenchido); com a UTM, a venda recuperada aparece como origem `recuperacao`.

**Falha no envio.** Sem provedor de e-mail configurado ou com recusa definitiva do provedor (chave ou mensagem
recusada), o lembrete fica como não enviado e não há nova tentativa (no pedido, a linha do tempo mostra **Lembrete por
e-mail não enviado**). Com erro temporário (rede, tempo esgotado, limite do provedor, resposta 429 ou 5xx), a fila tenta
de novo, mas só até 2 horas depois do horário previsto do lembrete (ou de quando ele entrou na fila, o que for mais
tarde); depois disso desiste e o lembrete fica como não enviado. **Lembrete parado mais de 2 horas na fila não sai**
(ex.: worker fora do ar): fica registrado como pulado, mesmo numa nova tentativa.

**Os textos.** Fixos (a loja não edita), com o nome da loja, o produto (o produto principal; se a oferta tem mais de um,
o nome da oferta) e o valor (contato: preço atual da oferta; Pix e cartão: total do pedido). Nunca o nome do comprador.

| Caso | Assunto | Título | Corpo | Botão |
|---|---|---|---|---|
| Contato | Sua compra de {produto} ficou pela metade | Ainda dá tempo de garantir {produto} | Você começou a comprar {produto} ({valor}) na {loja} e não terminou. Se quiser concluir, é só voltar: | Concluir minha compra |
| Pix | Seu Pix de {valor} ainda não foi pago | Seu Pix está pronto para pagar | Você gerou um Pix de {valor} para {produto} na {loja}, mas o pagamento ainda não chegou. O código vale até {data e hora de São Paulo}. Já pagou? Pode ignorar: o acesso chega assim que o banco confirmar. | Ver o Pix |
| Cartão | Sua compra de {produto} não foi concluída | O pagamento não foi concluído | Sua compra de {produto} ({valor}) na {loja} não foi concluída e nada foi cobrado. Você pode tentar de novo com Pix ou outro cartão: | Tentar de novo |

Rodapé de todos:

> Você recebeu este lembrete porque {motivo} na {loja}. Se não foi você, ignore este e-mail.
> **Não quero receber lembretes da {loja}**

`{motivo}`: no caso contato, "digitou este e-mail no checkout"; nos casos Pix e cartão, "iniciou uma compra".

**Descadastro.** O link do rodapé abre `/sair/<token>`, uma página com o botão de confirmar; só o botão (POST)
descadastra, porque leitores de link e antivírus abrem links com GET. O e-mail também leva os cabeçalhos
`List-Unsubscribe` e `List-Unsubscribe-Post` (descadastro de um clique pelo próprio Gmail ou Outlook). Descadastrar vale
para a loja inteira (os três casos), sem prazo, e para a **caixa de entrada** (como no limite por endereço: quem
descadastra `ana+promo@gmail.com` também não recebe em `ana@gmail.com` nem em `a.na@gmail.com`), e apaga os contatos
abertos ou contatados do e-mail do link. Com o Resend,
devolução (`email.bounced`) ou marcação como spam (`email.complained`) de **qualquer** e-mail da loja (inclusive o de
acesso) também tira o endereço da recuperação. A loja guarda só o **hash** do e-mail descadastrado e o da caixa (sem
eles não conseguiria respeitar o pedido). Link inventado, de outra loja ou vencido mostra "Este link não vale mais.".

- **Proxy e CDN: não registre a URL de `/sair/`.** O token de descadastro vai no caminho da URL (`/sair/<token>`), como
  a chave de envio em `/api/mcp/upload/`: desligue o log de URL para `/sair/` no proxy ou CDN.
- **Confira o `TRUST_PROXY`** (seção 2). A página aceita até 30 confirmações por IP por hora na loja; com
  `TRUST_PROXY` errado todo mundo parece ter o mesmo IP e o limite trava descadastros legítimos; com `TRUST_PROXY=0` o
  IP é desconhecido e o limite por IP não vale.

**Proteção do caso cartão.** Um robô que testa cartões roubados usa e-mails de outras pessoas; o lembrete não pode virar
spam contra elas. O lembrete do cartão é pulado (e fica registrado como pulado) se o pedido teve mais de 3 recusas, se o
disjuntor de cartão da loja disparou nas últimas 2 horas, se o IP do pedido teve mais de 3 recusas nas últimas 2 horas
ou se o IP é desconhecido (por isso, de novo, o `TRUST_PROXY` correto). Valem também os limites por endereço e o teto de
10 por hora. O texto não fala em "cartão recusado": diz que a compra não foi concluída, que nada foi cobrado e "se não
foi você, ignore este e-mail".

**Onde ver.** Sem item novo no menu. Em **Contatos**, a linha mostra "Lembrete enviado em {data}". No pedido, a linha do
tempo mostra **Lembrete de pagamento por e-mail** (ou **Lembrete por e-mail não enviado**, se o provedor recusou),
sem o destinatário. A visão geral ganha o cartão com **Lembretes enviados**, **Lembretes que viraram venda** e **Receita
recuperada** do período (aparece depois do primeiro lembrete enviado). **Recuperada** = pedido pago (ou depois
contestado ou reembolsado) da mesma oferta, do mesmo e-mail, até 7 dias depois do envio; a receita soma cada pedido uma
vez, mesmo que ele tenha recebido dois lembretes. Os números contam os lembretes enviados no período.

**Agentes de IA (MCP) e Telegram.** O MCP recebe só **números**, em `metrics.summary`, em qualquer papel:
`recovery.sent` (lembretes enviados no período), `recovery.recovered`, `recovery.recoveredRevenueCents` (centavos) e
`recovery.byCase` (`lead`, `pix`, `card`, cada um com `sent` e `recovered`). Nunca quem recebeu. O **Telegram não
recebe nada** da recuperação (os avisos de abandono que já existem seguem iguais).

**Retenção.** Cada lembrete fica guardado 90 dias, só com ids, hashes e datas (nunca e-mail, token nem link), e é
apagado pela mesma rotina de hora em hora que apaga os contatos. O link de descadastro vale enquanto o lembrete existir;
depois, mostra "Este link não vale mais." (a pessoa ainda pode responder a um e-mail da loja). Por isso os números da
recuperação cobrem só os últimos 90 dias. A lista de descadastros (`email_optout`) não vence. O envio grava no
histórico de e-mails (`email_log`) só o hash do destinatário. Os logs do app levam só ids, loja, caso e motivo.

**Base legal.** Isto não é parecer jurídico; leve isto ao jurídico junto com o aviso do checkout (seção anterior). Caso contato: o
aviso que a pessoa viu ("para falar com você se a compra não for concluída" e "só para lembrar você desta compra") cobre
um lembrete; base **legítimo interesse** (LGPD, art. 7º, IX), como na captura de contato; registre o teste de
balanceamento (o modelo da seção anterior serve). Casos Pix e cartão: a pessoa iniciou o pedido; o lembrete do próprio
pedido cabe em **procedimentos preliminares do contrato a pedido do titular** (art. 7º, V) ou em legítimo interesse.
Em todos: link de saída de um clique e nenhum uso além do lembrete.

## Cupons

Cupom é um código de desconto aplicado no checkout. Sem item novo no menu.

**Onde criar.** Em **Ofertas**, aba **Cupons**: lista, criar, editar e arquivar. Cada cupom tem:

- **Código:** de 3 a 32 caracteres (letras, números, `-` e `_`). Guardado em maiúsculas e único por loja.
- **Tipo:** percentual (de 0,01% a 90%) ou valor fixo em reais.
- **Ofertas:** as marcadas. Nenhuma marcada vale para todas as ofertas da loja.
- **Vale para:** por padrão, **só o produto principal**; o bump fica com preço fixo. Há a opção de estender o
  desconto ao bump (aí o desconto se divide entre os dois, na proporção).
- **Validade:** começa e termina em datas do horário de São Paulo; o cupom vale até o fim do último dia. Vazio: sem
  início ou sem fim.
- **Limite de usos:** total do cupom. Vazio: sem limite.
- **Limite por pessoa:** padrão **1**. Conta só **compras pagas** (pagas ou contestadas) e por **caixa de entrada**:
  `ana+promo@exemplo.com` e, no Gmail, `a.na@gmail.com` e `ana@gmail.com` são a mesma pessoa. Quem gerou um Pix com o
  cupom e desistiu para pagar no cartão consegue usar o cupom de novo; depois de uma compra paga, não.

**O que conta como uso (limite de usos).** Pedido **pago** ou **contestado**, mais os que ainda podem ser pagos: Pix
pendente que não venceu e cartão pendente criado há menos de 2 horas. Reembolsado, expirado e recusado não contam. A
conferência roda dentro do `checkout.start`, travada por cupom (criar pedido, editar e arquivar o cupom esperam um pelo
outro). Um cartão pendente há mais de 2 horas que seja aprovado depois pode passar do limite por poucos usos. O mesmo
vale para o limite por pessoa: como só a compra paga conta, dois pedidos pendentes da mesma pessoa podem ser pagos.

**Piso de R$ 5,00.** O total com desconto nunca fica abaixo de R$ 5,00. Se o desconto passar disso, ele é cortado e o
checkout mostra o desconto real. Se não sobrar desconto (total já no piso), o cupom é recusado. Com cupom, as
**parcelas** do cartão também são limitadas para nenhuma ficar abaixo de R$ 5,00 (ex.: R$ 22,00 numa oferta de até 5x
vira até 4x). Sem cupom, valem as parcelas configuradas na oferta, como antes. O mínimo de cobrança do Asaas para Pix e cartão
**ainda precisa ser confirmado no sandbox**; até lá vale o piso de R$ 5,00.

**No checkout.** "Tenho um cupom" fica recolhido; **Aplicar** mostra o desconto e o total. Cupom que não existe, venceu,
estourou o limite ou não vale para a oferta mostra sempre a mesma mensagem, **"Cupom inválido ou vencido"**, sem dizer
qual regra falhou. Isso vale também no envio: cupom que venceu (ou esgotou) entre a prévia e o "Pagar" mostra "Cupom
inválido ou vencido" e **não** cria o pedido. O valor mostrado é o valor cobrado: se o **total** mudar entre a prévia e o
envio (preço da oferta alterado, bump marcado ou desmarcado), o checkout avisa "O valor mudou: confira o resumo",
atualiza o resumo e **não** cria o pedido. Bump marcado que saiu da oferta mostra a mensagem do bump ("O acréscimo não
está mais disponível. Atualize a página."), na prévia e no envio.

**Pix manual com cupom.** O valor único do Pix manual soma de 1 a 99 centavos ao total (para identificar o pagamento no
extrato). Num desconto pequeno (ex.: R$ 0,50), esse acréscimo pode comer parte ou todo o desconto. O pedido e os
relatórios guardam o total com desconto; o acréscimo é só do valor do Pix.

**Link com cupom.** `/c/<slug>?cupom=CODIGO` abre o checkout com o cupom já aplicado (para anúncio e e-mail). O código
também entra na origem da venda como `cupom`.

**Contra adivinhação de códigos.**

- **20 por IP por hora:** conta toda tentativa com cupom, válida ou não: cada "Aplicar", cada envio do checkout com
  cupom e cada abertura de um link com `?cupom=`. Passou do limite, aquele IP fica sem cupom até a hora virar.
- **300 recusas por loja por hora:** conta só os cupons **recusados** (na prévia e no envio, inclusive pelo limite por
  pessoa). Com o balde cheio, **ninguém** aplica cupom na loja por até 1 hora; comprar sem cupom segue normal. Cupom
  válido não conta, então uma campanha com muito tráfego não trava a loja.

Confira o `TRUST_PROXY` (seção 2), senão todo mundo parece ter o mesmo IP e divide os mesmos 20.

**Arquivar.** O cupom para de valer na hora e **não se apaga, nem se edita, nem se religa**. O código continua ocupado,
então não dá para reaproveitá-lo. Para um desconto novo, crie outro cupom.

**Renomear.** Só cupom que ainda não tem pedido (de qualquer situação) pode trocar de código: o pedido guarda o cupom,
e renomear mudaria o código no histórico, no CSV e nas métricas. Cupom já usado: crie outro código. Os outros campos
(valor, validade, limites, ofertas, ligado) mudam normalmente e valem só para pedidos novos.

**Quem pode.** Criar, editar e arquivar: dono e administradores (permissão de editar ofertas). Os outros papéis veem a
lista com os botões desabilitados.

**Onde ver os resultados.**

- **Pedido:** mostra o cupom e o desconto.
- **CSV de pedidos:** ganha as colunas `cupom` e `desconto`.
- **Métricas:** por cupom, pedidos, desconto total e receita. Saem pelo `metrics.summary` (MCP, para agentes de IA);
  ainda não há tela no painel para elas.
- **Telegram:** o aviso de venda traz "Cupom: CODIGO (−R$ X)". O código não é dado pessoal.
- **Meta:** o `value` é o valor pago (já com desconto), no `Purchase` e no `InitiateCheckout`, inclusive o do navegador
  quando a página abre com `?cupom=` aplicado. Nenhum parâmetro novo.
- **Recuperação:** o lembrete de Pix e de cartão usa o valor com desconto; o lembrete de contato não leva o cupom.

**Agentes de IA (MCP).** Consultar (`coupons.list`, `coupons.get`) usa `offers.read`. Criar, editar e arquivar
(`coupons.create`, `coupons.update`, `coupons.archive`) usam `offers.write` e **passam pela fila de aprovação**, porque
mudam preço. `metrics.summary` traz `coupons` com código, pedidos, desconto e receita em centavos; `orders.get` traz
`couponCode` e `discountCents`; nunca dado de comprador.

## 14. Problemas comuns

- **O checkout não mostra o cartão e o painel avisa "falta configurar o serviço de cartão"**: a instalação está sem
  `CARD_ORIGIN` (ou o `.env` não foi relido). Configure a seção 12 e rode `docker compose up -d`.
- **Cartão: o checkout mostra "Pagamento com cartão indisponível agora"**: confira, nesta ordem, o DNS do
  `pagar.`, `docker compose ps` (`card` "healthy"), `docker compose logs card` e, se usa `CADDYFILE=Caddyfile.local`,
  se ele tem no fim a linha `import card/*.caddy` (seção 12). Teste com
  `curl -s -o /dev/null -w '%{http_code}\n' https://pagar.<seu domínio>/form.js` (deve mostrar `200`).
- **O Caddy não sobe e o log diz `ambiguous site definition: https://pagar.<seu domínio>`** (checkout e painel fora do
  ar): o site do cartão foi importado duas vezes, quase sempre porque o `deploy/Caddyfile.local` tem a linha
  `import card/*.caddy` repetida (ela já vem nas cópias feitas a partir desta versão). Deixe uma só
  (`grep -n 'import card/' deploy/Caddyfile.local`) e rode `docker compose up -d caddy`.

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
- **O app não sobe e o log mostra `lock timeout` (ou `canceling statement due to lock timeout`) logo depois de
  `migrate`:** a migração precisa de uma trava rápida numa tabela e desiste em 5 s se outra sessão está usando essa
  tabela há muito tempo (um `pg_dump` de backup em andamento, um `psql` aberto numa transação, uma consulta longa). O
  container tenta de novo sozinho; se o erro se repetir, espere o backup terminar ou ache quem segura a tabela:
  `docker compose exec -T postgres psql -U owner -d funil -c "select pid, state, now() - xact_start as tempo,
  left(query, 60) from pg_stat_activity where datname = 'funil' and xact_start is not null order by xact_start"`.
  Feche a sessão (ou `select pg_terminate_backend(<pid>)` nela, se for sua e puder ser interrompida) e rode
  `docker compose up -d app`.
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
- Estágio `card` do mesmo `deploy/Dockerfile` (`target: card` no compose; sobe sempre, desligado sem `CARD_ORIGIN`): o serviço
  de cartão num arquivo só (`bun run card:build`: `server.js`, `form.js`, `form.css`), sem `node_modules` nem nada do
  app, com `tini`, usuário `node` e verificação de saúde em `GET /healthz`. O compose dá 90 s para encerrar (uma
  cobrança em curso leva até ~75 s).
- `deploy/entrypoint.sh`: aplica as migrações com `OWNER_DATABASE_URL` (papel dono, superusuário do Postgres: algumas
  migrações copiam dados entre lojas e precisam passar por cima do isolamento por loja) e inicia o servidor com
  `DATABASE_URL` (papel `app`, sujeito ao isolamento), já sem `OWNER_DATABASE_URL` no ambiente. As migrações podem
  rodar quantas vezes for (a cada início) e são serializadas por uma trava no banco (dois containers subindo juntos
  não aplicam a mesma migration duas vezes).
- Verificação: `tests/smoke.sh` monta a imagem, sobe a pilha inteira com `DOMAIN=localhost` e faz uma compra de ponta
  a ponta (setup, produto com PDF de 46 MB, oferta, Pix manual, liberação, e-mail e download do PDF carimbado),
  medindo o pico de memória do container.
