<!-- revisar seção de pagamentos após merge do #43 -->

# Integração de apps com o funil

Este documento é para quem desenvolve um app com conta de usuário (o primeiro é o **PeticionaAqui**) e quer cobrar
pelo funil. Ele explica a integração do zero: o que configurar no painel, as duas chamadas que o servidor do app faz,
o aviso de pagamento que o app recebe e o que fazer com cada aviso.

Em uma frase: **o funil cobra, rastreia e avisa; o app é o dono da conta, do plano e dos créditos.** O funil não sabe
o que é um plano anual nem um crédito: ele cobra uma oferta e avisa o app com o código dela. Quem libera é o app.

Sumário:

1. [Visão geral](#1-visão-geral)
2. [Configuração no painel do funil](#2-configuração-no-painel-do-funil)
3. [Como chamar a API](#3-como-chamar-a-api)
4. [Início do teste: `POST /testes`](#4-início-do-teste-post-testes)
5. [Pagamento: `POST /pagamentos` e o checkout](#5-pagamento-post-pagamentos-e-o-checkout)
6. [Origem do cadastro (UTMs e Meta)](#6-origem-do-cadastro-utms-e-meta)
7. [Avisos de pagamento (webhook)](#7-avisos-de-pagamento-webhook)
8. [O que o PeticionaAqui faz em cada aviso](#8-o-que-o-peticionaaqui-faz-em-cada-aviso)
9. [Ambiente de teste](#9-ambiente-de-teste)
10. [Lista de conferência antes da produção](#10-lista-de-conferência-antes-da-produção)

Nos exemplos, `checkout.loja-exemplo.com.br` é o endereço do checkout da loja no funil e `app.exemplo.com.br` é o app.
`<CHAVE_DA_LOJA>` e `<SEGREDO_DO_WEBHOOK>` são valores que você copia do painel (seção 2). Nenhum valor deste documento
é real.

---

## 1. Visão geral

```mermaid
sequenceDiagram
    autonumber
    participant N as Navegador
    participant A as Servidor do app
    participant F as Funil
    participant P as Asaas

    N->>A: cadastro (com UTMs e cookies do Meta guardados)
    A->>F: POST /api/integracao/v1/testes (conta, e-mail, origem)
    F-->>A: 201 { id }
    Note over F: evento "início do teste" vai ao Meta

    Note over N,A: dias depois, a pessoa clica em "Pagar" no app
    N->>A: quero o plano X
    A->>F: POST /api/integracao/v1/pagamentos (conta, oferta, nome, e-mail, retorno)
    F-->>A: 201 { url, expira_em }
    A-->>N: redireciona para a url
    N->>F: checkout (nome e e-mail travados; CPF/CNPJ; Pix ou cartão)
    F->>P: cobrança
    P-->>F: pago
    F->>A: aviso assinado "pagamento.confirmado" (conta, pedido, app_code)
    A-->>F: 200
    Note over A: app libera o plano ou os créditos
    F-->>N: página de obrigado, botão "Voltar ao app" (retorno)
```

1. **Cadastro.** A pessoa chega ao app por um anúncio ou link com UTMs. O navegador guarda essa origem. Ao criar a conta
   (com o teste grátis de 7 dias), o servidor do app avisa o funil: `POST /testes`. O funil registra o teste e manda o
   evento de início de teste ao Meta.
2. **Pagamento.** Quando a pessoa decide pagar, o servidor do app pede ao funil uma sessão de pagamento:
   `POST /pagamentos`. O funil devolve uma URL de checkout que vale 60 minutos. O app redireciona o navegador para ela.
3. **Checkout.** O checkout abre com o nome e o e-mail já preenchidos e travados. A pessoa informa o que falta (CPF ou
   CNPJ, celular se o app não mandou, dados do cartão) e paga por Pix ou cartão.
4. **Aviso.** Quando o pagamento se confirma, o funil manda ao app um aviso assinado (`pagamento.confirmado`). Depois,
   se houver reembolso ou contestação, manda outros avisos do mesmo pedido.
5. **Liberação.** O app confere a assinatura e libera o plano ou os créditos **só pelo aviso**. A volta do navegador ao
   app (o `retorno`) é só conveniência: nunca libera nada.

Três regras guiam tudo o que vem a seguir:

- **A conta é a mesma em todo lugar.** O app manda a mesma `conta` no teste, no pagamento, e recebe a mesma `conta` no
  aviso. No PeticionaAqui, use o id do tenant (quem recebe o plano e os créditos), nunca o e-mail.
- **Só o aviso assinado libera.** Nada que venha do navegador (redirecionamento, parâmetro na URL, tela de obrigado)
  libera plano ou crédito.
- **Cada pagamento libera uma vez.** O aviso pode chegar repetido; o app deduplica pelo `id` do aviso e usa o `pedido`
  como chave da liberação.

---

## 2. Configuração no painel do funil

Quem tem acesso ao painel da loja faz isto uma vez, em **Conexões → App (integração)**.

### 2.1 Chave da API

Em **Chaves da API**, dê um nome à chave (ex.: "PeticionaAqui produção") e clique em **Criar chave**. A chave aparece
**uma única vez**: copie e guarde como segredo no servidor do app (no Supabase, um segredo das Edge Functions). Ela
começa com `fnl_`.

- Só o dono da loja cria e revoga chaves.
- A chave só serve para a API de integração (`/api/integracao/v1/*`). Ela não dá acesso ao painel nem a nada mais.
- Para trocar de chave: crie a nova, coloque no app, confira que funciona e só então **Revogar** a antiga. A chave
  revogada para de valer na hora.
- A chave nunca vai para o navegador, para o código do front-end nem para o repositório.

### 2.2 Webhook do app

No mesmo cartão, em **Webhook do app**:

| Campo | O que é |
|---|---|
| **URL do webhook** | Endereço do app que recebe os avisos de pagamento. Só `https`, em endereço público na internet (não vale IP local, privado nem interno), sem usuário e senha na URL e sem `#`. Ex.: `https://<projeto>.supabase.co/functions/v1/funil-avisos`. |
| **Hosts de retorno** | Para onde o checkout pode mandar a pessoa de volta depois do pagamento (o `retorno`, seção 5). Só o nome, um por linha, sem `https://`, porta nem caminho. Até 10. Ex.: `app.exemplo.com.br`. |
| **Endereço público do app** (opcional) | Onde a pessoa se cadastra, só `https://dominio` (sem caminho). Vai ao Meta como a página do evento de início do teste. Em branco, vale o endereço da loja. |

Ao salvar pela primeira vez, o funil gera o **segredo da assinatura** e o mostra **uma única vez**. Guarde-o no
servidor do app junto da chave: é com ele que o app confere cada aviso (seção 7.4).

- **Gerar segredo novo** troca o segredo. O anterior **para de valer na hora**: todo aviso enviado depois disso já vai
  assinado com o novo. Atualize o app logo em seguida (avisos que falharem nesse meio-tempo são tentados de novo).
- **Enviar teste** manda um aviso `ping` assinado para a URL e mostra o código HTTP que o app respondeu. Use para
  conferir a URL e o segredo.

### 2.3 Ofertas de app

Cada coisa que o app vende vira uma **oferta de app** no funil (entrega "app", escolhida ao criar a oferta). Ela tem:

- o **endereço** (slug), que o app manda em `oferta` ao criar o pagamento. Ex.: `start-anual`, `creditos-50`;
- o **código no app** (`app_code`), que volta no aviso para o app saber o que liberar. De 1 a 40 letras minúsculas,
  números ou `_`. Ex.: `start_anual`, `creditos_50`;
- o preço. A oferta de app é sempre à vista (sem parcelamento), sem cupom e sem produto adicional, e aceita Pix e
  cartão.

Combine com quem administra a loja a lista de ofertas, endereços, códigos e preços: o app precisa da mesma tabela de
`app_code` (seção 8).

---

## 3. Como chamar a API

- **Endereço base:** `https://checkout.loja-exemplo.com.br/api/integracao/v1` (o painel mostra o endereço exato da
  loja quando a chave é criada).
- **Só do servidor do app.** A chave é secreta; o navegador nunca chama esta API.
- **Método:** sempre `POST`, com corpo JSON (`Content-Type: application/json`), até **32 KB**.
- **Autenticação:** cabeçalho `Authorization: Bearer <CHAVE_DA_LOJA>`.
- **Limite:** **60 requisições por minuto por chave**. Acima disso, `429` com `Retry-After: 60`. Tentativas com chave
  inválida também têm limite por endereço IP.
- **Datas** em ISO 8601 com fuso (ex.: `2026-11-27T13:05:00Z` ou `2026-11-27T10:05:00-03:00`). **Dinheiro** sempre em
  centavos inteiros.

### 3.1 Formato dos erros

Todo erro vem no mesmo envelope:

```json
{
  "erro": {
    "codigo": "invalid_input",
    "mensagem": "Entrada inválida",
    "detalhes": [{ "campo": "email", "mensagem": "Confira o e-mail" }]
  }
}
```

`detalhes` só aparece quando ajuda: na entrada inválida, é a lista de campos com problema (`campo` usa ponto para campo
dentro de objeto, ex.: `origem.fbc`). O funil nunca devolve de volta o valor que você mandou.

| HTTP | `codigo` | Quando | O que fazer |
|---|---|---|---|
| 400 | `invalid_json` | O corpo não é JSON válido. | Corrigir o código. |
| 401 | `unauthorized` | Sem chave, chave malformada, revogada ou de outro tipo. A resposta é sempre a mesma. | Conferir a chave; não repetir em laço. |
| 404 | `not_found` | `POST /pagamentos` com oferta que não existe, está desativada ou não é oferta de app (`"Oferta de app não encontrada"`). | Conferir o endereço da oferta. |
| 405 | `method_not_allowed` | Método diferente de `POST`. | Corrigir o código. |
| 409 | `conflict` | Reservado para conflito de estado; hoje nenhum dos dois endpoints o devolve. Se vier, `detalhes` traz um `code` estável. | Tratar como erro definitivo. |
| 413 | `payload_too_large` | Corpo acima de 32 KB. | Corrigir o código. |
| 422 | `invalid_input` | Algum campo inválido (veja `detalhes`). | Corrigir o dado; repetir igual dá o mesmo erro. |
| 429 | `rate_limited` | Mais de 60 chamadas no minuto com a chave (ou chaves inválidas demais do mesmo IP). | Esperar o `Retry-After` (60 s) e tentar de novo. |
| 500 | `internal` | Falha do funil. A mensagem é sempre `"Falha interna"`. | Tentar de novo mais tarde, com espera crescente. |

As duas chamadas podem ser repetidas com segurança (seções 4 e 5): numa falha de rede ou `5xx`, repita a mesma
chamada.

---

## 4. Início do teste: `POST /testes`

O servidor do app chama logo depois do cadastro, uma vez por conta.

### 4.1 Campos

| Campo | Obrigatório | Regra |
|---|---|---|
| `conta` | sim | Id da conta no app, texto de 1 a 64 caracteres. **Não pode ter `@`**: use o id interno, nunca o e-mail. No PeticionaAqui, o id do tenant. |
| `email` | sim | E-mail do cadastro, até 254 caracteres. O funil não guarda o e-mail em claro: guarda só um resumo criptográfico (hash) para o Meta e para ligar o teste ao pagamento. |
| `nome` | não | 2 a 120 caracteres. Aceito e descartado (o funil não guarda). |
| `telefone` | não | Até 30 caracteres. Aceito e descartado. |
| `origem` | não | De onde a pessoa veio (seção 6): `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `fbclid` (até 500 caracteres cada), `ref` (até 100), `fbc` e `fbp` (até 500). Campo vazio é ignorado. |
| `ip` | não | IP do navegador no cadastro (até 64 caracteres). Só serve ao Meta; valor que não é IP é ignorado. |
| `user_agent` | não | User agent do navegador no cadastro (até 500). Só serve ao Meta. |
| `iniciado_em` | não | Quando o teste começou (ISO 8601 com fuso). Padrão: agora. Aceita até **7 dias** para trás (um pouco menos, por segurança) e até 60 segundos no futuro (vale como agora). Fora disso, `422`. |
| `event_id` | não | Só se o app também dispara o evento de início de teste pelo Pixel do Meta no navegador: o mesmo id nos dois lados faz o Meta contar uma vez só. 16 a 64 caracteres (letras, números, `_` e `-`). |

O que acontece:

- O funil registra o teste da conta e, se a loja tem o Meta conectado, manda o evento **StartTrial** (valor 0, BRL) com o
  e-mail em hash, a conta em hash, `fbc`, `fbp`, IP e user agent.
- **Uma vez por conta.** A primeira chamada cria o registro e responde `201`. As seguintes, com a mesma `conta`,
  respondem `200` com o mesmo `id` e **não mudam nada** (nem a origem) nem mandam outro evento ao Meta. Por isso a
  chamada pode ser repetida à vontade.
- IP e user agent ficam guardados só até o evento sair ao Meta, e no máximo 7 dias. Sem o Meta conectado, nem são
  guardados.
- Um teste que não virou pagamento é apagado depois de 180 dias. Teste de conta que pagou fica enquanto o pedido existir.

Se o funil estiver fora do ar no cadastro, **não bloqueie o cadastro**: guarde a chamada e tente de novo depois,
mandando o `iniciado_em` original (vale por até 7 dias).

### 4.2 Exemplo

```sh
curl -sS https://checkout.loja-exemplo.com.br/api/integracao/v1/testes \
  -H "Authorization: Bearer <CHAVE_DA_LOJA>" \
  -H "Content-Type: application/json" \
  -d '{
    "conta": "3f0c2a9e-5b7d-4e1a-9c3b-1d2e4f6a8b0c",
    "email": "pessoa@exemplo.com.br",
    "nome": "Pessoa Exemplo",
    "origem": {
      "utm_source": "facebook",
      "utm_medium": "cpc",
      "utm_campaign": "lancamento-novembro",
      "utm_content": "video-1",
      "fbclid": "IwAR0exemplo",
      "fbc": "fb.1.1764240000000.IwAR0exemplo",
      "fbp": "fb.1.1764239000000.1234567890"
    },
    "ip": "203.0.113.10",
    "user_agent": "Mozilla/5.0 (exemplo)"
  }'
```

Teste novo (`201 Created`):

```json
{ "id": "6b1f3c2e-8a4d-4f0b-9e7a-2c5d1b3a4e6f" }
```

A mesma conta de novo (`200 OK`), mesmo `id`:

```json
{ "id": "6b1f3c2e-8a4d-4f0b-9e7a-2c5d1b3a4e6f" }
```

E-mail inválido (`422 Unprocessable Entity`):

```json
{
  "erro": {
    "codigo": "invalid_input",
    "mensagem": "Entrada inválida",
    "detalhes": [{ "campo": "email", "mensagem": "Confira o e-mail" }]
  }
}
```

Outras mensagens de `422` que você pode ver: `"Use o id interno da conta, não o e-mail"` (`conta` com `@`),
`"A conta pode ter no máximo 64 caracteres"`, `"Data no futuro"` e `"Data antiga demais (no máximo 7 dias)"`
(`iniciado_em`).

Chave errada (`401 Unauthorized`):

```json
{ "erro": { "codigo": "unauthorized", "mensagem": "Chave de integração ausente ou inválida" } }
```

---

## 5. Pagamento: `POST /pagamentos` e o checkout

O servidor do app chama quando a pessoa clica em pagar, e redireciona o navegador para a `url` que volta.

### 5.1 Campos

| Campo | Obrigatório | Regra |
|---|---|---|
| `conta` | sim | A mesma `conta` do teste (1 a 64 caracteres, sem `@`). É ela que volta no aviso. |
| `oferta` | sim | Endereço (slug) da oferta de app no funil. Ex.: `start-anual`. |
| `email` | sim | E-mail do comprador (até 254). Aparece travado no checkout. |
| `nome` | sim | Nome do comprador, 2 a 120 caracteres. Aparece travado no checkout. |
| `telefone` | não | Celular com DDD (ex.: `11987654321`; aceita máscara e `+55`). Se vier inválido, `422` (`"Celular com DDD, ex.: 11987654321"`). Se não vier, o checkout pede. |
| `origem` | não | Os mesmos campos do teste (seção 6). Se vier **qualquer** campo, a origem deste pagamento é a que veio; se não vier nada, o funil usa a origem guardada no teste da conta. |
| `retorno` | não | Para onde o botão **Voltar ao app** da página de obrigado leva. URL `https`, sem usuário e senha, até 2048 caracteres, com host igual ao do checkout da loja ou a um dos **Hosts de retorno** (seção 2.2). Host fora da lista (ou com porta) dá `422` no campo `retorno`. |

Recomendação para a `origem`: **não mande** no pagamento, a menos que a conta não tenha passado pelo `POST /testes`
(ex.: contas criadas antes da integração). Assim o pagamento herda a origem do cadastro, que é a que importa para as
campanhas.

O que acontece:

- O funil cria uma **sessão de pagamento** com a conta, o comprador, a oferta e a origem, e devolve `url` e `expira_em`.
- A `url` tem a forma `https://checkout.loja-exemplo.com.br/c/<oferta>?s=<id da sessão>`. Ela não leva dado pessoal,
  mas quem a tem vê o nome e o e-mail no checkout: trate como privada (não registre em log, não mande por e-mail, não
  reaproveite depois de vencer).
- **Vale 60 minutos.** Crie uma sessão nova a cada clique em pagar; não guarde a URL para depois.
- **Repetição segura.** A mesma chamada (mesma conta, oferta, nome, e-mail, telefone e retorno) em até 2 minutos, sem
  pedido ainda, devolve a **mesma** sessão com `200`. Assim um clique duplo ou uma nova tentativa de rede não cria dois
  links. Mudou algum desses campos, ou passou de 2 minutos: sessão nova, `201`.

### 5.2 Exemplo

```sh
curl -sS https://checkout.loja-exemplo.com.br/api/integracao/v1/pagamentos \
  -H "Authorization: Bearer <CHAVE_DA_LOJA>" \
  -H "Content-Type: application/json" \
  -d '{
    "conta": "3f0c2a9e-5b7d-4e1a-9c3b-1d2e4f6a8b0c",
    "oferta": "start-anual",
    "email": "pessoa@exemplo.com.br",
    "nome": "Pessoa Exemplo",
    "telefone": "11987654321",
    "retorno": "https://app.exemplo.com.br/assinatura/obrigado"
  }'
```

Sessão nova (`201 Created`):

```json
{
  "url": "https://checkout.loja-exemplo.com.br/c/start-anual?s=8e2d4c1a-7b3f-4a9e-b5c6-0d1e2f3a4b5c",
  "expira_em": "2026-12-04T14:05:00.000Z"
}
```

A mesma chamada em até 2 minutos (`200 OK`): o mesmo corpo, com a mesma `url`.

Oferta inexistente, desativada ou que não é de app (`404 Not Found`):

```json
{ "erro": { "codigo": "not_found", "mensagem": "Oferta de app não encontrada" } }
```

`retorno` fora dos hosts configurados (`422 Unprocessable Entity`):

```json
{
  "erro": {
    "codigo": "invalid_input",
    "mensagem": "Use um endereço https no domínio da loja ou do app",
    "detalhes": [{ "campo": "retorno", "mensagem": "Use um endereço https no domínio da loja ou do app" }]
  }
}
```

### 5.3 Redirecionar e o checkout

Com a resposta em mãos, o app manda o navegador para a `url` (redirecionamento `303` do servidor ou
`window.location.assign(url)` no front-end). No checkout:

- nome e e-mail vêm da sessão, travados (a pessoa não troca a conta nem o produto);
- o checkout pede só o que falta: **CPF ou CNPJ** (a loja do PeticionaAqui aceita os dois), o celular se o app não
  mandou, e os dados do cartão se a pessoa escolher cartão;
- não há cupom nem produto adicional: o preço é o da oferta;
- a oferta de app **não abre sem sessão**. Aberta sem `?s=`, a página mostra "Abra o pagamento pelo app", sem
  formulário.

**Sessão inválida.** Se a sessão venceu (mais de 60 minutos), já foi paga, é de outra oferta ou de outra loja, o
checkout não mostra o formulário e diz: "Este link de pagamento venceu. Volte ao app e tente de novo." Se a pessoa
tentar pagar com uma sessão que ficou inválida no meio do caminho, o funil recusa sem criar pedido (internamente, um
`409` com `detalhes.code` = `SESSION_INVALID`, que só o checkout vê). Do lado do app, basta oferecer o botão de pagar
de novo: ele cria uma sessão nova.

**Pix e cartão na mesma sessão.** A pessoa pode gerar um Pix e, antes de pagar, desistir e pagar com cartão: a página
do Pix tem o link "Pagar com cartão", que continua na mesma sessão. Cada tentativa é um pedido do funil.

**Uma liberação por sessão.** Se a pessoa acabar pagando duas vezes na mesma sessão (por exemplo, pagou com cartão e
depois pagou também o Pix que tinha gerado), **só o primeiro pagamento gera `pagamento.confirmado`**. O segundo vira um
alerta para o vendedor devolver o dinheiro; o app não precisa fazer nada. Pagamentos em sessões diferentes são compras
diferentes: cada uma tem o seu `pedido` e o seu `pagamento.confirmado`.

### 5.4 O retorno

Depois que o pagamento se confirma, o checkout mostra a página de obrigado ("O acesso é liberado no app") com o botão
**Voltar ao app**, que leva para o `retorno` exatamente como o app mandou (o funil não acrescenta parâmetros). Sem
`retorno`, a página só pede para a pessoa voltar ao app.

Na página de retorno, o app **não libera nada**: ela só mostra o estado que o app já conhece (ex.: "Pagamento
confirmado, seu plano está ativo" se o aviso já chegou, ou "Estamos confirmando o pagamento" e atualiza sozinha até o
aviso chegar). No Pix, a pessoa pode fechar a página do funil antes de pagar e pagar depois; o aviso chega do mesmo
jeito.

---

## 6. Origem do cadastro (UTMs e Meta)

O pagamento costuma acontecer 7 dias ou mais depois do clique no anúncio. Para o funil mostrar as vendas por campanha e
o Meta ligar o pagamento ao anúncio, o app guarda a origem **no momento em que a pessoa chega** e a manda no
`POST /testes`.

O que guardar:

| Dado | De onde vem | Campo em `origem` |
|---|---|---|
| UTMs | Parâmetros da URL de entrada: `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term` | os mesmos nomes |
| Clique do Meta | Parâmetro `fbclid` da URL de entrada | `fbclid` |
| Indicação | Parâmetro `ref` da URL de entrada | `ref` |
| Cookie `_fbc` | Criado pelo Pixel do Meta no domínio do app quando a pessoa chega por um anúncio | `fbc` |
| Cookie `_fbp` | Criado pelo Pixel do Meta no domínio do app (identifica o navegador) | `fbp` |

Regras:

- Guarde o **primeiro toque**: a primeira entrada com parâmetros. Uma visita depois, sem parâmetros (a pessoa digitou o
  endereço), não apaga a origem guardada.
- Sem o Pixel do Meta no app, os cookies `_fbc` e `_fbp` não existem. Mande o `fbclid` mesmo assim: o funil monta o
  `fbc` a partir dele.
- `ip` e `user_agent` vão no `POST /testes`, tirados da requisição do cadastro (não precisam ser guardados antes).
- A mesma `conta` no teste e no pagamento faz o Meta ligar o início do teste à compra (os dois eventos levam a conta em
  hash como identificador da pessoa). O evento de compra leva o `app_code` da oferta como produto.

Exemplo para o front-end do app, rodando em toda página pública (antes do cadastro):

```ts
const CHAVE = "origem_entrada";
const CAMPOS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid", "ref"] as const;

/** Guarda o primeiro toque com parâmetros. Chame no carregamento de toda página pública do app. */
export function guardarOrigemDaEntrada(): void {
  try {
    if (localStorage.getItem(CHAVE)) return; // o primeiro toque vence
    const q = new URLSearchParams(location.search);
    const origem: Record<string, string> = {};
    for (const campo of CAMPOS) {
      const valor = q.get(campo)?.trim();
      if (valor) origem[campo] = valor.slice(0, campo === "ref" ? 100 : 500);
    }
    if (Object.keys(origem).length > 0) localStorage.setItem(CHAVE, JSON.stringify(origem));
  } catch {
    // navegador sem armazenamento: segue sem origem
  }
}

function cookie(nome: string): string | undefined {
  const m = document.cookie.match(new RegExp(`(?:^|; )${nome}=([^;]*)`));
  return m ? decodeURIComponent(m[1]).slice(0, 500) : undefined;
}

/** O objeto `origem` para mandar ao servidor do app junto com o cadastro. */
export function origemParaOCadastro(): Record<string, string> {
  let guardada: Record<string, string> = {};
  try {
    guardada = JSON.parse(localStorage.getItem(CHAVE) ?? "{}");
  } catch {
    // ignora valor corrompido
  }
  const fbc = cookie("_fbc");
  const fbp = cookie("_fbp");
  return { ...guardada, ...(fbc ? { fbc } : {}), ...(fbp ? { fbp } : {}) };
}
```

No cadastro, o front-end manda `origemParaOCadastro()` ao servidor do app, e o servidor repassa como `origem` no
`POST /testes`. Se o app guardar a origem também na conta (ex.: uma coluna na tabela do tenant), dá para reenviar o
teste mais tarde sem depender do navegador.

---

## 7. Avisos de pagamento (webhook)

O funil avisa o app de tudo o que acontece com um pagamento por um `POST` na **URL do webhook** (seção 2.2).

### 7.1 Entrega

- **Prazo:** o app precisa responder com **2xx em até 10 segundos**. Qualquer outra coisa (3xx, 4xx, 5xx, sem resposta,
  tempo esgotado) conta como falha. Redirecionamento não é seguido. O corpo da resposta é ignorado.
- **Novas tentativas:** depois de uma falha, o funil tenta de novo em 1 min, 5 min, 30 min, 2 h, 6 h e 24 h (7
  tentativas no total, cerca de 32 horas e meia entre a primeira e a última). Se todas falharem, o aviso fica como
  falho, o vendedor recebe um alerta no painel e pode usar **Reenviar aviso ao app** no pedido.
- **Ao menos uma vez:** o mesmo aviso pode chegar mais de uma vez (nova tentativa, reenvio manual, resposta que se perdeu
  na rede). Sempre com o **mesmo `id`**. O app deduplica pelo `id` (seção 7.5).
- **Em ordem por pedido:** um aviso só sai depois que os anteriores do mesmo pedido foram entregues ou desistidos. A
  exceção é o reenvio manual de um aviso que tinha falhado, que pode chegar depois de avisos mais novos: é para isso que
  existe a `sequencia` (seção 7.5).
- **Reenvio manual:** o botão **Reenviar aviso ao app** manda o aviso não entregue mais antigo do pedido (ou, com tudo
  entregue, o último), com o mesmo `id` e as tentativas recomeçando.

### 7.2 Cabeçalhos

| Cabeçalho | Valor |
|---|---|
| `Content-Type` | `application/json` |
| `User-Agent` | `funil-webhook/1` |
| `Funil-Evento` | O `id` do aviso (o mesmo do corpo). |
| `Funil-Assinatura` | `t=<unix>,v1=<hex>`: `t` é o instante do envio em segundos; `v1` é o HMAC-SHA256, em hexadecimal minúsculo, de `t + "." + corpo` com o segredo do webhook como chave. |

Cada tentativa é assinada de novo, com o `t` do momento do envio.

### 7.3 Corpo

Todo aviso tem a mesma forma:

```json
{
  "id": "evt_9f2c4e1a7b3d5f6e8a0c2b4d6f8e1a3c",
  "tipo": "pagamento.confirmado",
  "criado_em": "2026-12-04T13:12:40.512Z",
  "dados": { }
}
```

- `id`: identificador do aviso, `evt_` seguido de 32 caracteres hexadecimais. Fixo para aquele aviso, em toda nova
  tentativa e reenvio.
- `tipo`: um dos tipos da tabela abaixo.
- `criado_em`: quando o funil registrou o aviso (não muda entre tentativas).
- `dados`: o pedido, nos avisos de pagamento:

| Campo de `dados` | Tipo | O que é |
|---|---|---|
| `conta` | texto | A `conta` que o app mandou no `POST /pagamentos`. |
| `pedido` | texto | Id público do pedido no funil. É a chave da liberação no app. |
| `app_code` | texto | O código no app da oferta paga (seção 2.3). |
| `valor_centavos` | inteiro | Valor total do pedido em centavos. |
| `metodo` | texto | `pix` ou `cartao`. |
| `pago_em` | texto ou `null` | Quando o pagamento se confirmou (ISO 8601). |
| `sequencia` | inteiro | Ordem do aviso dentro do pedido: 1, 2, 3... (seção 7.5). |
| `valor_estornado_centavos` | inteiro | Só em `pagamento.reembolso_parcial`: total devolvido até aqui. |

Os `dados` descrevem o pedido como ele foi pago: não mudam com o estado atual (uma confirmação que chega atrasada,
depois do reembolso, continua sendo a confirmação). O aviso nunca leva e-mail, nome, telefone nem CPF/CNPJ: o app já
conhece a conta.

Tipos:

| `tipo` | Quando |
|---|---|
| `pagamento.confirmado` | O pagamento do pedido se confirmou. Sempre a `sequencia` 1 do pedido, e no máximo um por pedido. |
| `pagamento.reembolsado` | O pedido foi reembolsado por inteiro (pelo painel do funil ou direto no Asaas). |
| `pagamento.reembolso_parcial` | Parte do valor foi devolvida direto no Asaas (o painel do funil não oferece reembolso parcial em pedido de app). O pedido continua pago. Sai um aviso novo cada vez que o total devolvido **aumenta**. |
| `pagamento.contestado` | O comprador contestou o pagamento no cartão (chargeback). |
| `pagamento.restabelecido` | A contestação foi resolvida a favor da loja: o pagamento voltou a valer. |
| `ping` | Só pelo botão **Enviar teste** do painel. `dados` vazio; não tem novas tentativas. |

Todo aviso de um pedido vem depois do `pagamento.confirmado` dele: o funil garante que a confirmação exista antes de
qualquer reembolso ou contestação.

Exemplos completos de `dados` em cada tipo (mesmo pedido):

```jsonc
// pagamento.confirmado
{ "id": "evt_9f2c4e1a7b3d5f6e8a0c2b4d6f8e1a3c", "tipo": "pagamento.confirmado", "criado_em": "2026-12-04T13:12:40.512Z",
  "dados": { "conta": "3f0c2a9e-5b7d-4e1a-9c3b-1d2e4f6a8b0c", "pedido": "Hk3vX9a2LmQ7pR4tY8wZ1b", "app_code": "creditos_50",
             "valor_centavos": 9700, "metodo": "pix", "pago_em": "2026-12-04T13:12:39.870Z", "sequencia": 1 } }

// pagamento.reembolso_parcial (total devolvido até agora: R$ 20,00)
{ "id": "evt_1b3d5f7a9c2e4a6c8e0b2d4f6a8c0e2b", "tipo": "pagamento.reembolso_parcial", "criado_em": "2026-12-06T10:00:02.118Z",
  "dados": { "conta": "3f0c2a9e-5b7d-4e1a-9c3b-1d2e4f6a8b0c", "pedido": "Hk3vX9a2LmQ7pR4tY8wZ1b", "app_code": "creditos_50",
             "valor_centavos": 9700, "metodo": "pix", "pago_em": "2026-12-04T13:12:39.870Z", "sequencia": 2,
             "valor_estornado_centavos": 2000 } }

// pagamento.reembolsado
{ "id": "evt_2c4e6a8b0d2f4a6c8e1b3d5f7a9c1e3d", "tipo": "pagamento.reembolsado", "criado_em": "2026-12-08T09:30:11.004Z",
  "dados": { "conta": "3f0c2a9e-5b7d-4e1a-9c3b-1d2e4f6a8b0c", "pedido": "Hk3vX9a2LmQ7pR4tY8wZ1b", "app_code": "creditos_50",
             "valor_centavos": 9700, "metodo": "pix", "pago_em": "2026-12-04T13:12:39.870Z", "sequencia": 3 } }
```

```jsonc
// Outro pedido, no cartão: pagamento.contestado e depois pagamento.restabelecido
{ "id": "evt_3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a3c", "tipo": "pagamento.contestado", "criado_em": "2027-01-10T18:44:03.250Z",
  "dados": { "conta": "3f0c2a9e-5b7d-4e1a-9c3b-1d2e4f6a8b0c", "pedido": "Qa8sD2fG4hJ6kL8zX0cV2b", "app_code": "start_anual",
             "valor_centavos": 199000, "metodo": "cartao", "pago_em": "2026-12-15T11:02:17.000Z", "sequencia": 2 } }

{ "id": "evt_4e6a8c0e2a4c6e8b0d2f4a6c8e0b2d4f", "tipo": "pagamento.restabelecido", "criado_em": "2027-02-02T12:10:55.731Z",
  "dados": { "conta": "3f0c2a9e-5b7d-4e1a-9c3b-1d2e4f6a8b0c", "pedido": "Qa8sD2fG4hJ6kL8zX0cV2b", "app_code": "start_anual",
             "valor_centavos": 199000, "metodo": "cartao", "pago_em": "2026-12-15T11:02:17.000Z", "sequencia": 3 } }
```

```json
{ "id": "evt_5f7b9d1f3b5d7f9a1c3e5a7c9e1b3d5f", "tipo": "ping", "criado_em": "2026-11-27T13:00:00.000Z", "dados": {} }
```

O mesmo tipo pode aparecer mais de uma vez no mesmo pedido (ex.: contestado, restabelecido, contestado de novo, ou
dois reembolsos parciais): cada ocorrência tem `id` e `sequencia` próprios.

### 7.4 Conferir a assinatura (TypeScript, Web Crypto)

Confira **antes de qualquer outra coisa**, com o corpo cru (o texto exatamente como chegou, antes de `JSON.parse`).
O código abaixo usa só Web Crypto, então roda em Supabase Edge Functions (Deno), Node 18+, Bun e Cloudflare Workers.

```ts
/** Diferença máxima aceita entre o `t` da assinatura e o relógio do app. */
const JANELA_SEGUNDOS = 5 * 60;
const utf8 = new TextEncoder();

function lerAssinatura(cabecalho: string | null): { t: number; v1: string[] } | null {
  if (!cabecalho) return null;
  let t: number | null = null;
  const v1: string[] = [];
  for (const parte of cabecalho.split(",")) {
    const i = parte.indexOf("=");
    if (i < 0) continue;
    const nome = parte.slice(0, i).trim();
    const valor = parte.slice(i + 1).trim();
    if (nome === "t" && /^\d{1,12}$/.test(valor)) t = Number(valor);
    else if (nome === "v1" && /^[0-9a-f]{64}$/.test(valor)) v1.push(valor);
  }
  return t === null || v1.length === 0 ? null : { t, v1 };
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compara sem parar no primeiro caractere diferente (tempo constante para textos do mesmo tamanho). */
function iguais(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diferenca = 0;
  for (let i = 0; i < a.length; i++) diferenca |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diferenca === 0;
}

/**
 * true se o aviso veio do funil. `segredos`: o segredo atual (e, durante uma troca de segredo, também o anterior).
 * `corpo`: o corpo cru da requisição. `agoraMs`: relógio do app (injetável em teste).
 */
export async function avisoAutentico(
  segredos: string[],
  corpo: string,
  cabecalho: string | null,
  agoraMs: number = Date.now(),
): Promise<boolean> {
  const assinatura = lerAssinatura(cabecalho);
  if (!assinatura) return false;
  if (Math.abs(Math.floor(agoraMs / 1000) - assinatura.t) > JANELA_SEGUNDOS) return false;
  const mensagem = utf8.encode(`${assinatura.t}.${corpo}`);
  for (const segredo of segredos) {
    const chave = await crypto.subtle.importKey("raw", utf8.encode(segredo), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const esperado = hex(await crypto.subtle.sign("HMAC", chave, mensagem));
    if (assinatura.v1.some((recebido) => iguais(recebido, esperado))) return true;
  }
  return false;
}
```

- O segredo entra como texto UTF-8, exatamente como o painel mostrou.
- A janela de 5 minutos barra a repetição de um aviso antigo capturado. Mantenha o relógio do servidor sincronizado
  (NTP).
- Assinatura inválida: responda `401` e não processe. O funil vai tentar de novo e, se continuar falhando, o vendedor é
  alertado (normalmente é o segredo desatualizado no app).

Recebedor completo como Supabase Edge Function:

```ts
// supabase/functions/funil-avisos/index.ts
import { createClient } from "jsr:@supabase/supabase-js@2";
import { avisoAutentico } from "./assinatura.ts";

const segredos = [Deno.env.get("FUNIL_WEBHOOK_SEGREDO"), Deno.env.get("FUNIL_WEBHOOK_SEGREDO_ANTERIOR")].filter(
  (s): s is string => Boolean(s),
);
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response(null, { status: 405 });
  const corpo = await req.text(); // cru: a assinatura é sobre estes bytes
  if (!(await avisoAutentico(segredos, corpo, req.headers.get("Funil-Assinatura")))) {
    return new Response("assinatura inválida", { status: 401 });
  }
  const aviso = JSON.parse(corpo);
  if (aviso.tipo === "ping") return new Response(null, { status: 204 });
  // Dedupe, ordem e liberação numa transação só, no banco (seção 8).
  const { error } = await supabase.rpc("processar_aviso_funil", { p_aviso: aviso });
  if (error) return new Response("falha", { status: 500 }); // o funil tenta de novo
  return new Response(null, { status: 200 });
});
```

O funil não manda o cabeçalho `Authorization` do Supabase: publique essa função **sem a verificação de JWT**
(`supabase functions deploy funil-avisos --no-verify-jwt`, ou `verify_jwt = false` no `config.toml`). Quem autentica o
aviso é a assinatura.

### 7.5 Idempotência e ordem

Duas regras, aplicadas na mesma transação em que o app libera ou retira algo:

1. **Pelo `id`: cada aviso é processado uma vez.** Guarde o `id` de todo aviso processado (chave única). Se o `id` já
   existe, responda `200` e não faça nada.
2. **Pela `sequencia`: transição antiga é descartada.** Guarde, por `pedido`, a maior `sequencia` já aplicada. Um aviso
   com `sequencia` **menor** que ela é antigo (um reenvio manual que chegou atrasado): registre o `id`, responda `200` e
   não aplique. A mesma `sequencia` de novo é o mesmo aviso, já barrado pelo `id`.

Para essa regra funcionar, o app trata cada aviso como uma **mudança de estado do pedido**, não como um comando cego:
o aviso de maior `sequencia` diz como o pedido deve estar agora (liberado, suspenso ou retirado), e o app faz só o que
falta para chegar lá. Retira só o que foi liberado, devolve só o que foi suspenso, e libera se ainda não tinha liberado
(seção 8).

Dois exemplos do porquê, ambos com a confirmação (`sequencia` 1) falhando em todas as tentativas porque o app estava
fora do ar:

- Depois sai o reembolso (`sequencia` 2) e o app o recebe: o pedido deve estar retirado, e como nada foi liberado, nada
  é tirado. Se o vendedor reenviar a confirmação, ela chega depois do reembolso; pela regra 2, é descartada e o pedido
  continua sem nada liberado, que é o certo.
- Depois sai uma contestação (`sequencia` 2) e a resolução a favor da loja (`sequencia` 3): ao receber a resolução, o
  pedido deve estar liberado e ainda não foi, então o app libera ali. A confirmação reenviada depois é descartada.

Responda `2xx` só depois de gravar (o `id`, a `sequencia` e a liberação). Se o banco falhar, responda `5xx`: o funil
tenta de novo com o mesmo `id`.

---

## 8. O que o PeticionaAqui faz em cada aviso

O PeticionaAqui já tem `assinaturas` (o plano do tenant), `peticao_credito_ledger` (o extrato de créditos),
`asaas_webhook_eventos` (os avisos do Asaas) e a função `creditar_recarga_peticao(tenant, quantidade, pedido)`. A
integração com o funil reaproveita o que existe e acrescenta duas tabelas pequenas.

Atenção: a cobrança é feita na conta do Asaas **do funil**, não na do app. Esses pagamentos não chegam ao webhook do
Asaas do PeticionaAqui (`asaas_webhook_eventos`); a única fonte é o aviso do funil.

### 8.1 Tabelas

```sql
-- O que cada app_code libera (preencher com a tabela combinada com a loja, seção 2.3).
create table funil_produtos (
  app_code   text primary key,
  tipo       text not null check (tipo in ('plano_anual', 'creditos')),
  plano      text,     -- tipo plano_anual: o plano do PeticionaAqui (ex.: 'start', 'plus', 'firma')
  quantidade integer,  -- tipo creditos: quantos créditos
  check ((tipo = 'plano_anual' and plano is not null) or (tipo = 'creditos' and quantidade > 0))
);

-- Todo aviso processado (regra 1 da seção 7.5).
create table funil_avisos (
  id          text primary key,           -- "evt_..."
  tipo        text not null,
  pedido      text not null,
  sequencia   integer not null,
  aplicado    boolean not null,           -- false: descartado por sequência antiga
  recebido_em timestamptz not null default now()
);

-- Estado de cada pedido do funil no app (regra 2 da seção 7.5).
create table funil_pedidos (
  pedido           text primary key,      -- dados.pedido
  tenant           uuid not null,         -- dados.conta
  app_code         text not null references funil_produtos (app_code),
  valor_centavos   integer not null,
  ultima_sequencia integer not null,
  -- nada: nunca liberado; liberado: com o cliente; suspenso: tirado por contestação; retirado: reembolsado
  estado           text not null check (estado in ('nada', 'liberado', 'suspenso', 'retirado')),
  estornado_centavos integer not null default 0
);
```

Ajuste os tipos ao que o PeticionaAqui já usa (ex.: se o tenant não é `uuid`). Ligue RLS nessas tabelas sem nenhuma
política para usuários: só a Edge Function, com a chave de serviço, mexe nelas.

### 8.2 Ação por aviso

Cada aviso aplicado leva o pedido a um estado; o app faz só o que falta para chegar nele:

| Aviso | Estado que o pedido deve ter |
|---|---|
| `pagamento.confirmado` | `liberado` |
| `pagamento.contestado` | `suspenso` (se nunca foi liberado, continua `nada`) |
| `pagamento.restabelecido` | `liberado` |
| `pagamento.reembolsado` | `retirado` |
| `pagamento.reembolso_parcial` | não muda; se o pedido ainda estava `nada` (a confirmação se perdeu), `liberado`, porque só pedido pago recebe reembolso parcial |

`retirado` é final: nenhum aviso depois do reembolso total devolve o que foi retirado.

O que fazer em cada passagem:

| De → para | Pacote de créditos | Plano anual |
|---|---|---|
| `nada` → `liberado` | `creditar_recarga_peticao(tenant, quantidade, pedido)`, com o `pedido` como chave: chamada repetida com o mesmo pedido não credita de novo. | Ativa o plano anual na assinatura **existente** do tenant: troca o plano, marca como ativo e define o fim para 1 ano depois de `pago_em` (ou soma 1 ano ao fim atual, se já houver plano anual ativo). **Não cria outro teste** nem reinicia o teste de 7 dias. Guarde o `pedido` na assinatura. |
| `liberado` → `suspenso` | Debita a `quantidade` no ledger, com referência ao `pedido`. | Suspende a assinatura, sem apagar. |
| `suspenso` → `liberado` | Credita de novo a `quantidade` (referência ao `pedido`, distinta da recarga original). | Reativa a assinatura com o mesmo fim. |
| `liberado` → `retirado` | Debita a `quantidade`. | Encerra a assinatura anual do pedido. |
| `suspenso` → `retirado` | Nada: a contestação já debitou. | Encerra a assinatura anual do pedido. |
| `nada` → `retirado` | Nada a retirar. | Nada a retirar. |

`pagamento.reembolso_parcial` também grava `valor_estornado_centavos` em `estornado_centavos` e avisa a equipe.
Sugestão: **não retirar nada automaticamente**, porque reembolso parcial em pedido de app só acontece por ação manual
direto no Asaas, e quem fez combinou algo com o cliente.

Créditos já gastos: se o tenant gastou parte dos créditos antes do reembolso ou da contestação, o débito pode deixar o
saldo negativo. Decida se o app aceita saldo negativo (o mais simples e fiel) ou se zera e avisa a equipe.

Um aviso que chega para um `pedido` desconhecido traz nos `dados` tudo o que é preciso para criar a linha em
`funil_pedidos`: a `conta`, o `app_code` e o valor.

### 8.3 Esqueleto da função no banco

Tudo numa transação só, chamada pela Edge Function da seção 7.4:

```sql
create or replace function processar_aviso_funil(p_aviso jsonb) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_id        text    := p_aviso->>'id';
  v_tipo      text    := p_aviso->>'tipo';
  v_dados     jsonb   := p_aviso->'dados';
  v_pedido    text    := v_dados->>'pedido';
  v_seq       integer := (v_dados->>'sequencia')::integer;
  v_atual     funil_pedidos;
  v_produto   funil_produtos;
  v_alvo      text;
begin
  -- Regra 1: cada id uma vez. Duas entregas simultâneas do mesmo id: a segunda esbarra na chave primária de
  -- funil_avisos no fim, é desfeita inteira (500) e, na nova tentativa do funil, cai aqui.
  if exists (select 1 from funil_avisos where id = v_id) then
    return 'repetido';
  end if;

  select * into v_produto from funil_produtos where app_code = v_dados->>'app_code';
  if not found then
    raise exception 'app_code desconhecido: %', v_dados->>'app_code'; -- 500: o funil tenta de novo; corrija a tabela
  end if;

  -- Linha do pedido, travada até o fim da transação.
  insert into funil_pedidos (pedido, tenant, app_code, valor_centavos, ultima_sequencia, estado)
  values (v_pedido, (v_dados->>'conta')::uuid, v_produto.app_code, (v_dados->>'valor_centavos')::integer, 0, 'nada')
  on conflict (pedido) do nothing;
  select * into v_atual from funil_pedidos where pedido = v_pedido for update;

  -- Regra 2: aviso com sequência menor que a última aplicada é antigo e não muda nada.
  if v_seq < v_atual.ultima_sequencia then
    insert into funil_avisos (id, tipo, pedido, sequencia, aplicado) values (v_id, v_tipo, v_pedido, v_seq, false);
    return 'antigo';
  end if;

  -- Estado que o pedido deve ter depois deste aviso (seção 8.2).
  v_alvo := case v_tipo
    when 'pagamento.confirmado'        then 'liberado'
    when 'pagamento.restabelecido'     then 'liberado'
    when 'pagamento.contestado'        then case when v_atual.estado = 'nada' then 'nada' else 'suspenso' end
    when 'pagamento.reembolsado'       then 'retirado'
    when 'pagamento.reembolso_parcial' then case when v_atual.estado = 'nada' then 'liberado' else v_atual.estado end
    else v_atual.estado
  end;
  if v_atual.estado = 'retirado' then
    v_alvo := 'retirado'; -- reembolso total é final
  end if;

  -- Só o que falta para sair do estado atual e chegar no alvo.
  if v_atual.estado = 'nada' and v_alvo = 'liberado' then
    perform liberar_compra_funil(v_atual, v_produto);   -- créditos: creditar_recarga_peticao(tenant, quantidade, pedido)
  elsif v_atual.estado = 'liberado' and v_alvo = 'suspenso' then
    perform suspender_compra_funil(v_atual, v_produto);
  elsif v_atual.estado = 'suspenso' and v_alvo = 'liberado' then
    perform devolver_compra_funil(v_atual, v_produto);
  elsif v_atual.estado in ('liberado', 'suspenso') and v_alvo = 'retirado' then
    perform retirar_compra_funil(v_atual, v_produto);   -- recebe o estado atual: se 'suspenso', os créditos já saíram
  end if;

  if v_tipo = 'pagamento.reembolso_parcial' then
    update funil_pedidos set estornado_centavos = (v_dados->>'valor_estornado_centavos')::integer where pedido = v_pedido;
    -- avisar a equipe (sugestão da seção 8.2)
  end if;

  update funil_pedidos set estado = v_alvo, ultima_sequencia = v_seq where pedido = v_pedido;
  insert into funil_avisos (id, tipo, pedido, sequencia, aplicado) values (v_id, v_tipo, v_pedido, v_seq, true);
  return 'aplicado';
end;
$$;
```

`liberar_compra_funil`, `suspender_compra_funil`, `devolver_compra_funil` e `retirar_compra_funil` são do app: elas
mexem em `assinaturas` e em `peticao_credito_ledger` conforme a tabela da seção 8.2. A linha nova em `funil_pedidos`
nasce como `nada` (nada liberado).

---

## 9. Ambiente de teste

- **Loja de teste.** Peça a quem administra o funil uma loja separada para testes, com a conexão do Asaas em modo
  **sandbox**. Ela tem chave, segredo e ofertas próprios: nunca use a chave de produção no ambiente de teste do app.
- **Webhook de teste.** Aponte a URL do webhook da loja de teste para o ambiente de teste do app e clique em **Enviar
  teste**: o painel mostra o código HTTP que o app respondeu. Espere `2xx`; `401` quase sempre é o segredo errado.
- **Pagamentos no sandbox.** No cartão, use o cartão de teste do Asaas sandbox (`4444 4444 4444 4444`, qualquer
  validade futura e CVV). No Pix, confirme o recebimento da cobrança pelo painel do Asaas sandbox.
- **Roteiro mínimo:**
  1. `POST /testes` com uma conta nova → `201`; repetir → `200` com o mesmo `id`.
  2. `POST /pagamentos` → abrir a `url`, conferir nome e e-mail travados, pagar com cartão de teste → receber
     `pagamento.confirmado` e ver o plano ou os créditos liberados uma vez só.
  3. Reenviar o mesmo aviso pelo pedido no painel (**Reenviar aviso ao app**) → o app responde `200` e não libera de
     novo.
  4. Reembolsar o pedido pelo painel do funil → receber `pagamento.reembolsado` e ver o que foi liberado ser retirado.
  5. Abrir uma `url` com mais de 60 minutos → o checkout mostra "Este link de pagamento venceu".
  6. Mandar um aviso com a assinatura alterada (ou com `t` de 10 minutos atrás) para a sua função → `401`.

---

## 10. Lista de conferência antes da produção

Funil (com quem administra a loja):

- [ ] Ofertas de app criadas e ativas, com endereço, `app_code` e preço combinados; a mesma tabela em `funil_produtos`.
- [ ] Chave da API de produção criada, guardada como segredo do servidor do app e fora do repositório.
- [ ] URL do webhook de produção salva; segredo guardado no app; **Enviar teste** respondendo `2xx`.
- [ ] Hosts de retorno com o domínio do app; endereço público do app preenchido.
- [ ] Meta conectado na loja, se as campanhas vão usar o início de teste.

App:

- [ ] `POST /testes` chamado do servidor em todo cadastro novo, com `conta` = id do tenant (sem `@`), `origem`, `ip` e
      `user_agent`; falha do funil não bloqueia o cadastro e é reenviada depois.
- [ ] Origem guardada na primeira entrada (UTMs, `fbclid`, `ref`) e cookies `_fbc`/`_fbp` lidos no cadastro.
- [ ] `POST /pagamentos` chamado a cada clique em pagar, com a mesma `conta`; a `url` não é guardada nem registrada em
      log; `404` e `422` mostram uma mensagem útil à pessoa.
- [ ] Nenhuma liberação pelo retorno do navegador; a página de retorno só mostra o estado.
- [ ] Recebedor do webhook: confere a assinatura com o corpo cru, recusa `t` fora de 5 minutos, responde em menos de 10
      segundos, `2xx` só depois de gravar.
- [ ] Dedupe pelo `id` (chave única) e descarte por `sequencia` menor, na mesma transação da liberação.
- [ ] Os cinco tipos tratados (confirmado, reembolsado, reembolso parcial, contestado, restabelecido) e `ping`
      respondendo `2xx`.
- [ ] Créditos creditados com o `pedido` como chave (confirmado que a função recusa pedido repetido); plano anual ativado
      sem recriar o teste.
- [ ] Relógio do servidor sincronizado; segredo da assinatura trocável sem deploy (variável de ambiente), com espaço
      para o anterior durante a troca.
- [ ] Nenhum dado pessoal (e-mail, nome, telefone) em log do lado do app ao chamar o funil ou receber avisos.
- [ ] Roteiro da seção 9 executado na loja de teste.
