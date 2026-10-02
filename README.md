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

> ⚠️ **Nunca** versione a pasta `data/` (ela tem pedidos de clientes e o hash da senha). O `.gitignore` da raiz já bloqueia, assim como `.env` e `node_modules/`.

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
