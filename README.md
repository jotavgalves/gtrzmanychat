# GTRZ Flow

Painel próprio de automação para Instagram, inspirado no fluxo operacional do ManyChat, construído sobre a API oficial da Meta e Cloudflare Workers.

## O que já existe nesta V1

- comentário → Private Reply no Direct;
- gatilho por qualquer comentário ou por palavra-chave;
- regra global ou limitada a uma publicação específica;
- prioridade entre automações;
- opção de disparar apenas uma vez por contato;
- cooldown por automação;
- kill switch global;
- modo de simulação sem enviar DM;
- dashboard com métricas das últimas 24 horas;
- CRM de contatos;
- inbox para mensagens recebidas e respostas manuais;
- log detalhado de disparos e erros;
- deduplicação de comentários e webhooks;
- processamento assíncrono com Cloudflare Queues;
- retries específicos para rate limit da Meta;
- validação `X-Hub-Signature-256` dos webhooks;
- login administrativo por cookie HttpOnly assinado;
- banco D1 com bootstrap automático no primeiro uso e migration versionada.

## Arquitetura

```text
Instagram / Meta Webhooks
          │
          ▼
Cloudflare Worker ───────► D1
          │
          ▼
 Cloudflare Queue
          │
          ▼
 mesmo Worker (consumer)
          │
          ▼
Instagram Send API
```

O frontend está em `public/` e é servido como Static Assets do mesmo Worker. Os caminhos `/api/*` e `/webhooks/*` passam primeiro pelo Worker.

## Requisitos da Meta

Use uma conta profissional do Instagram e um app configurado para **Instagram API with Instagram Login**.

Permissões usadas pelo projeto:

- `instagram_business_basic`
- `instagram_business_manage_comments`
- `instagram_business_manage_messages`

Campos de webhook usados pela V1:

- `comments`
- `messages`

A Private Reply inicial é enviada usando o `comment_id`. A Meta limita esse recurso a uma única mensagem privada inicial vinculada ao comentário; a continuidade da conversa depende de uma resposta do usuário e das regras de mensageria aplicáveis.

Coleção oficial da Meta para Instagram API:

- https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api
- https://www.postman.com/meta/instagram/request/23987686-189d7215-22b3-403f-b2f5-a46c7e66a514

## Deploy no Cloudflare

### 1. Instale e autentique

```bash
npm install
npx wrangler login
```

### 2. Primeiro deploy

```bash
npm run deploy
```

O `wrangler.jsonc` usa automatic provisioning para D1 e Queues. O Worker também cria as tabelas automaticamente no primeiro acesso autenticado ou no primeiro lote recebido pela Queue.

A migration permanece disponível para gestão explícita:

```bash
npm run db:migrate:remote
```

### 3. Configure os secrets

```bash
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET
npx wrangler secret put META_VERIFY_TOKEN
npx wrangler secret put META_APP_SECRET
npx wrangler secret put INSTAGRAM_ACCESS_TOKEN
```

Nunca coloque esses valores no repositório. Para desenvolvimento local, copie `.dev.vars.example` para `.dev.vars` e preencha apenas na sua máquina.

### 4. Faça novo deploy

```bash
npm run deploy
```

### 5. Configure o webhook na Meta

Abra **Configurações → Meta + Cloudflare** dentro do GTRZ Flow e copie a Callback URL exibida pelo próprio sistema. Ela será:

```text
https://SEU-WORKER.workers.dev/webhooks/instagram
```

No Meta for Developers:

1. use essa Callback URL;
2. em Verify Token, coloque exatamente o mesmo valor salvo em `META_VERIFY_TOKEN`;
3. assine `comments` e `messages`;
4. confirme que o app e a conta possuem as permissões necessárias.

## Desenvolvimento local

```bash
cp .dev.vars.example .dev.vars
npm install
npm run dev
```

Para criar a estrutura manualmente no D1 local:

```bash
npm run db:migrate:local
```

Para validar a sintaxe dos módulos do projeto:

```bash
npm run check
```

## Estrutura

```text
public/
  index.html              painel
  app.css                 entrada dos estilos
  app-core.css            estrutura e design system
  app-components.css      dashboard, tabelas, inbox e modais
  app.js                  carregador do frontend
  app-core.js             estado, API client e automações
  app-features.js         CRM, inbox, configurações e eventos
src/
  index.js                entrypoint do Worker
  api.js                  endpoints administrativos
  webhook.js              verificação, recepção e Queue consumer
  auth.js                 sessão administrativa
  db.js                   D1, bootstrap e helpers
  meta.js                 integração Instagram/Meta
  automation-crud.js      criação e edição de regras
  automation-runner.js    matching, dedupe e execução
migrations/
  0001_initial.sql        schema versionado
wrangler.jsonc            Worker, assets, D1 e Queues
```

## Segurança

- secrets ficam somente nos bindings do Cloudflare;
- o access token nunca é retornado ao navegador;
- o webhook só aceita payload com assinatura válida do App Secret;
- o login usa cookie `HttpOnly`, `SameSite=Strict` e assinatura HMAC;
- IDs são gerados com `crypto.randomUUID()`;
- nenhum disparo real é feito pelo modo de simulação;
- a Queue usa entrega at-least-once, e o sistema mantém deduplicação por webhook, comentário e execução.

## Comportamento de falhas

- `429` da Meta é reenfileirado com atraso;
- respostas ambíguas/5xx são registradas como `uncertain` para evitar disparos duplicados agressivos;
- após o limite de retries da Queue, eventos podem ir para `gtrzmanychat-events-dlq`;
- o kill switch interrompe novas DMs automáticas sem apagar configurações ou dados.
