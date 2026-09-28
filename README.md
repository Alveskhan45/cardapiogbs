# 🥤 Cardápio Digital

Cardápio digital de bebidas com carrinho, cupons, PIX, +18, controle de estoque e painel administrativo.

- **Front (cardápio):** pasta `public/` (HTML+CSS+JS puros, sem build)
- **Backend (opcional/remoto):** `server.js` (Node/Express) + `data/db.json`

---

## 🚀 GitHub Pages (grátis — só o cardápio)

Modo **estático/offline**: o cardápio, carrinho, cupons, QR PIX, favoritos e pedidos via **WhatsApp** funcionam normalmente. Sem acompanhamento de pedido nem sincronização com o painel entre aparelhos — por isso o painel admin em cada navegador salva localmente (a senha \u00e9 definida por voc\u00ea no painel > Seguran\u00e7a).

### Como publicar

1. Crie um repositório `sua-conta.github.io` (ou um repo normal).

2. Dentro do repositório, copie o conteúdo da pasta `public/` para a raiz:

   ```
   public/
     index.html
     css/
     js/
     manifest.json
     sw.js
     .nojekyll  (já incluído — evita problemas com Jekyll)
   ```

3. **GitHub → Settings → Pages** → em *Build and deployment*, escolha:
   - **Source: Deploy from a branch** → branch `main`, pasta `/ (root)`.
   - (Ou **GitHub Actions** — não é necessário para este projeto).

4. Seu site fica em `https://sua-conta.github.io/nome-do-repo/` (ou `https://sua-conta.github.io/` se for repo de usuário).

### Subindo pelo terminal

```bash
cd public
git init
git add .
git commit -m "Cardápio digital - GitHub Pages"
git branch -M main
git remote add origin https://github.com/SUA-CONTA/SEU-REPO.git
git push -u origin main
```

> 📌 **Nunca** suba a pasta `data/` (contém pedidos reais e hash de senha) — o `.gitignore` na raiz do projeto já bloqueia.

---

## 🖥️ Usar no PC (completo, incluindo painel)

```bash
node server.js
```

Abre em `http://localhost:3000`. O servidor imprime no terminal uma **senha inicial aleatória** na primeira execução (ela só aparece nessa vez — anote). Depois disso a senha só existe como hash em `data/db.json` e só muda pelo painel, em **⚙️ → Segurança**.

## ☁️ Publicar com o backend completo (futuro)

Para pedidos persistentes, acompanhamento e painel sincronizado, é preciso hospedar o **projeto inteiro** (não só `public/`) num host Node — ex.: Render (free tier), Railway ou uma VPS, ou expor seu PC com Cloudflare Tunnel. Instruções detalhadas podem ser adicionadas depois.