# 🛒 Cardápio Digital

Cardápio digital para distribuidora de bebidas, com carrinho, cupons, PIX, restrição +18, controle de estoque e painel administrativo.

**Site no ar:** https://alveskhan45.github.io/cardapiogbs/

## O que tem dentro

| Área | Onde | Detalhe |
| --- | --- | --- |
| Cardápio (front) | `index.html`, `css/`, `js/`, `assets/` | HTML + CSS + JS puros, sem build |
| Backend (opcional) | `server.js` | Node.js + Express, API REST e eventos em tempo real (SSE) |
| Dados | `data/db.json` | Criado na primeira execução, fora do git |

## GitHub Pages (grátis — só o cardápio)

No modo estático o cardápio, o carrinho, os cupons, o QR PIX, os favoritos e o envio do pedido pelo **WhatsApp** funcionam normalmente. Não há acompanhamento de pedido nem sincronização do painel entre aparelhos — por isso, nesse modo o painel admin salva os dados localmente no navegador (a senha é definida por você em **⚙️ Configurações → Segurança**).

O front já está na **raiz do repositório**, então o Pages serve direto — não precisa mover arquivo nenhum.

1. **Settings → Pages** → *Build and deployment* → *Source*: **Deploy from a branch**, branch `main`, pasta `/ (root)`.
2. O `.nojekyll` já está na raiz e evita o Jekyll de mexer nos arquivos.
3. O site fica em `https://<sua-conta>.github.io/<nome-do-repo>/`.

## Rodar no PC (completo, com painel sincronizado)

```bash
npm install
npm start
```

Abre em `http://localhost:3001` (ou em `$PORT`, se você definir). Na primeira execução o servidor imprime no terminal uma **senha inicial aleatória** — ela aparece só naquela vez, anote. Depois disso a senha existe apenas como hash em `data/db.json` e você troca pelo painel, em **🔐 Segurança**.

```bash
PORT=8080 npm start   # roda em outra porta
```

## Publicar com o backend

Para persistir pedidos, acompanhar status e sincronizar o painel entre aparelhos, hospede o projeto inteiro num host Node — por exemplo Render, Railway ou uma VPS. O `server.js` já lê a porta do ambiente (`process.env.PORT`).

### Checklist final de deploy/produção

1. Copie `.env.example` para `.env` e substitua todos os valores reais antes do primeiro rollout.
2. Defina `NODE_ENV=production`, `JWT_SECRET` com pelo menos 32 caracteres e `SUPER_ADMIN_PASS` com senha forte, exclusiva do ambiente.
3. Configure `ALLOWED_ORIGINS` com os domínios públicos reais da plataforma, incluindo HTTPS e subdomínios permitidos.
4. Defina `WILDCARD_DOMAIN` como o domínio raiz do SaaS (ex.: `seusaas.com`), com DNS wildcard e certificado TLS válidos para `*.seusaas.com`.
5. Rode o script de validação para produção antes de publicar: `npm run prod:check` e `npm run health`.
6. Aplique as migrations em um ambiente de produção preparado: `npm run migrate`.
7. Configure `DATABASE_URL` e `SUPER_ADMIN_DATABASE_URL` com usuários distintos, credenciais fortes e acesso restrito via rede privada ou secrets manager.
8. Ative backups automáticos do PostgreSQL e valide restore em uma rotina periódica antes de abrir para clientes.
9. Garanta observabilidade mínima: logs estruturados, request IDs, health check de uptime, alertas por falha e monitoramento de erro.
10. Faça smoke test completo em produção: login do super-admin, criação de tenant, login do tenant, pedido de teste e acompanhamento de status.

### Hardening de produção

- `NODE_ENV=production` e checagens automáticas de segurança na inicialização do servidor.
- `JWT_SECRET` obrigatório e rejeitado quando ainda está em placeholders ou abaixo de 32 caracteres.
- `WILDCARD_DOMAIN` e `ALLOWED_ORIGINS` validados para impedir domínios locais ou valores vazios em produção.
- `SUPER_ADMIN_PASS` tem que ser forte e não pode ficar em padrão gerado automaticamente para produção.
- CORS e Helmet ativos para reduzir riscos de XSS, clickjacking e abuso de origem.
- Logs sanitizados: tokens, cookies, senhas e chaves confidenciais não são expostos no output.
- Request IDs e logging estruturado para facilitar correlação de incidentes e depuração em produção.
- Health check exposto em `/api/health` e script `npm run health` para validação do processo após deploy.
- Acesso administrativo restrito; o painel da plataforma não deve ficar exposto sem autenticação forte e rede/ACL apropriadas.

### Checklist de rollout e seguranca

- [ ] `.env` preenchido com valores reais, sem placeholders
- [ ] `npm run prod:check` passou em produção
- [ ] `npm run test` passou no ambiente de validação
- [ ] `npm run migrate` executado com sucesso
- [ ] TLS/HTTPS ativo no domínio principal e subdomínios
- [ ] Backups do PostgreSQL agendados e restauracao testada
- [ ] Alertas de uptime e logs em observabilidade habilitados
- [ ] Tenant de teste e super-admin validados em produção
- [ ] Rotina de rollback e senha de recuperação do host documentada

## Estrutura

```
.
├── index.html          # cardápio + painel (uma página)
├── 404.html
├── manifest.json
├── .nojekyll
├── css/style.css
├── js/
│   ├── state.js        # estado + persistência
│   ├── menu.js         # render do cardápio
│   ├── cart.js         # carrinho
│   ├── checkout.js     # dados do pedido, frete, CEP
│   ├── app.js          # bootstrap do front
│   ├── admin.js        # painel (produtos, pedidos, clientes…)
│   ├── admin-login.js  # tela de senha
│   ├── admin-*.js      # dashboard, pedidos, entregas, log
│   ├── backup.js       # exportar / restaurar ZIP
│   └── vendor/         # qrcode.min.js
├── assets/produtos/
├── server.js           # API REST + SSE
└── package.json
```

## Requisitos

Node.js 18 ou superior (só a dependência é `express`).

---

## Multi-tenant (SaaS)

Cada distribuidora e uma **loja isolada** (tenant) da plataforma. Dados, config,
usuarios e uploads nao se misturam: o isolamento e garantido no proprio Postgres
(Row Level Security), alem das regras da aplicacao.

Uploads de produtos aceitam apenas JPEG, PNG, GIF e WebP de até 5 MB. O servidor
confere o conteúdo do arquivo e define a extensão a partir do formato detectado,
sem confiar no nome ou no tipo informado pelo navegador.

### Subir o ambiente local

```bash
docker compose up -d db      # Postgres 16 (porta host 5433)
cp .env.example .env         # ajuste JWT_SECRET e SUPER_ADMIN_PASS
npm run migrate              # cria schema, indices, RLS e planos
npm start                    # http://localhost:3001
```

Cardapio de uma loja especifica em dev: `http://localhost:3001/?tenant=legado`
(o header `X-Tenant-ID` tambem funciona; em producao quem define e o subdominio).

### Painel da plataforma

`/pages/super-admin.html` � login com `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASS`.
Cria lojas (com admin, config padrao e dados demo), muda plano, suspende,
remove e **entra como** admin de uma loja (impersonacao em aba separada).

O fluxo de cadastro verifica a disponibilidade do subdomínio antes de criar,
bloqueia nomes reservados, inicializa os dados e arquivos da loja de forma
coordenada e mostra as credenciais geradas uma única vez. Lojas em trial já
são provisionadas com a data final do período de 14 dias.

### Migrar a loja atual (single-tenant)

```bash
npm run migrate:legacy       # le data/db.sqlite -> tenant "legado"
```

O hash de senha atual e preservado: quem ja usava a senha do painel antigo
continua entrando sem trocar nada. Use `--dry-run` para so conferir.

### Enderecos de cada loja em producao

- `https://cliente.seusaas.com` (DNS curinga + certificado curinga; ver `nginx.conf`)
- `TENANT_RESOLVER`: `auto` (padrao), `subdomain`, `header` ou `path`
- `TENANT_STRICT=1` aceita apenas a fonte indicada em `TENANT_RESOLVER`

### Autenticacao

- Loja: `POST /api/auth/login` com **e-mail + senha** (o tenant vem do host)
- Plataforma: `POST /api/super-admin/login`
- Painel legado `/api/login` continua existindo (mesmo corpo, e-mail + senha)
- Token JWT em `x-token` (front atual) ou `Authorization: Bearer`
- Refresh token com rotacao: `POST /api/auth/refresh`
- Eventos em tempo real do painel usam tickets SSE de uso unico, de curta
  duracao e vinculados ao tenant, sem expor o JWT na URL.
- Consultas públicas são limitadas por IP e loja: 120/min para cardápio,
  planos e dados públicos da loja; 60/min para status e rastreio de pedidos.

### Planos, cobrança e quotas

- Os planos aceitam `-1` ou `0` como ilimitado; limites positivos são cotas máximas.
- O limite mensal de pedidos é conferido pelo backend nos últimos 30 dias; o armazenamento considera o uso atual em disco.
- Somente o administrador da loja pode registrar uma intenção de pagamento. O valor é obtido do preço cadastrado do plano; comprovantes são analisados manualmente no painel da plataforma.
- A aprovação do pagamento aplica o plano solicitado, reativa a loja e acrescenta 30 dias à assinatura em uma única transação.
- Lojas em trial deixam de aceitar tráfego após `trial_ends_at`; assinaturas deixam de aceitar tráfego após `subscription_expires_at`. O painel da plataforma continua disponível para regularização.

### Testes

```bash
npm test
```

Roda a suite de isolamento num banco separado (`cardapio_test`): loja A nao ve
produtos/pedidos/config/uploads da loja B, token de uma loja nao abre a outra,
sessao suspensa nao entra, quotas do plano bloqueiam, RLS no banco e impersonacao.
Sai com codigo 1 se algo falhar (usado no CI).

### Scripts

| comando                  | o que faz                                    |
| ------------------------ | -------------------------------------------- |
| `npm run db:up`          | sobe o Postgres (docker)                     |
| `npm run db:backup`      | exporta backup do PostgreSQL em `./backups` |
| `npm run migrate`        | aplica migrations pendentes                   |
| `npm run migrate:legacy` | migra o SQLite antigo para o tenant `legado` |
| `npm run health`         | checa o health endpoint em produção/local    |
| `npm test`               | suite de isolamento multi-tenant             |
| `npm start`              | sobe a API + front                           |