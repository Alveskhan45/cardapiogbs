# Relatório de Progresso — CardapioDigital SaaS

**Última atualização:** 09/10/2026
**Projeto:** `C:\Users\Admin\Desktop\Alves\Github\cardapiogbs`

---

## 1. Como rodar

```powershell
node server.js          # sobe em http://localhost:3001
node scripts/migrate.js # aplica migrations (também roda sozinho no boot)
```

| Recurso | URL |
|---|---|
| Landing / página de vendas | `http://localhost:3001/landing` |
| Painel Super Admin | `http://localhost:3001/pages/super-admin.html` |
| Cardápio de uma loja | `http://localhost:3001/?tenant=<subdomain>` |
| Health check | `http://localhost:3001/api/health` |

**Login Super Admin:** `admin@seusaas.com` / `admin123`
⚠️ Não há hot-reload: mudanças em `server.js`, `routes/` ou `services/` exigem reiniciar o processo.

---

## 2. Decisões de negócio em vigor

Definidas com o cliente (veja `contratacao.txt` para o raciocínio completo):

| Item | Decisão |
|---|---|
| Modelo de cobrança | **Mensal** |
| Forma de pagamento | **Somente PIX, manual** (sem gateway externo) |
| Momento da conta | **Conta criada ANTES do pagamento** |
| Gateway (Mercado Pago/Stripe) | **Não integrado** — fora de escopo |

---

## 3. Fluxo de contratação implementado

```
Landing → "Contratar {plano}"
   ↓
Modal de cadastro (loja, responsável, WhatsApp, e-mail, senha)
   ↓
POST /api/public/signup
   • cria a loja em TRIAL no plano GRÁTIS (link já funciona)
   • cria assinatura com status awaiting_payment
   • gera signup_token (salvo no navegador)
   ↓
Cliente vê chave PIX + valor  →  paga  →  clica "Já paguei"
   ↓
POST /api/public/contract/:token/confirm
   • gera payment_proof PENDENTE
   • assinatura vira payment_reported
   ↓
Super Admin (notificação em tempo real)
   ↓
POST /api/super-admin/subscriptions/:id/activate
   • ativa o plano por 30 dias
   • gera CÓDIGO DE ACESSO (8 caracteres, sem 0/O/1/I)
   • loga em super_admin_audit
   ↓
Admin envia o código por WhatsApp
```

**Regra crítica respeitada:** o frontend **nunca** libera plano pago. Só a aprovação explícita do Super Admin ativa.

---

## 4. Funcionalidades entregues

### 4.1 Notificações do Super Admin (tempo real)
- Polling a cada **25s** em `js/super-admin.js`
- Gatilhos: novo comprovante de pagamento, **nova contratação (lead)**, nova loja cadastrada
- Aviso no navegador (Notification API) + som (WebAudio) + barra flutuante com botão "Abrir no WhatsApp"
- Preferências salvas em `localStorage` (`super_admin_notif`)

### 4.2 Contratação self-service
| Camada | Arquivo / rota |
|---|---|
| Serviço | `services/contracting.js` |
| Cadastro | `POST /api/public/signup` |
| Acompanhamento | `GET /api/public/contract/:token` |
| Informar pagamento | `POST /api/public/contract/:token/confirm` |
| Admin: listar | `GET /api/super-admin/subscriptions?status=` |
| Admin: liberar | `POST /api/super-admin/subscriptions/:id/activate` |
| Leads | `GET /api/super-admin/leads`, `PUT /api/super-admin/leads/:id` |
| Lead público | `POST /api/public/leads` |

### 4.3 Ajustes no painel (últimos)
- Aba "Pagamentos & Liberação" renomeada para **Notificações**
- **Sem paginação** na lista de lojas e na auditoria (Super Admin vê tudo)
- Auditoria: botão **Limpar** exige a senha do próprio Super Admin; a própria limpeza é registrada em log
- Layout: barras de topo e resultados com a mesma largura (`--topbar-h:72px` + wrapper de 1400px)

### 4.4 Configuração da plataforma (aba Configurações)
- WhatsApp de divulgação (`saas_templates.support_whatsapp`) = **5585985708628**
- Chave PIX = `018a773e-2f0c-44cc-8308-ac8047429a5f` · Titular = *CardapioDigital SaaS*
- Alterar nome/e-mail/senha do Super Admin
- Aparência: cor primária + tema claro/escuro (`localStorage`)

---

## 5. Banco de dados — estado atual

**Migrations aplicadas:** `000` … `006`

| Tabela | Função |
|---|---|
| `saas_templates` | modelos WhatsApp, `pix_key`, `pix_name`, `support_whatsapp` |
| `payment_proofs` | comprovantes enviados pelos lojistas |
| `super_admin_audit` | trilha de ações do painel |
| `super_admins` | contas do gestor da plataforma |
| **`saas_leads`** | contatos/clicks da landing page |
| **`subscriptions`** | assinaturas (plano, ciclo mensal, status, `signup_token`, `access_code`) |

**Contadores:** subscriptions=4 · leads=11 · payment_proofs=1 · audit=1

**Lojas cadastradas (11):**

| Subdomain | Plano | Status | Origem |
|---|---|---|---|
| `demo` | free | active | demonstração |
| `smoke844624` | starter | active | 🧹 teste automatizado |
| `smoke084207` | starter | active | 🧹 teste automatizado |
| `smoke157705` | starter | active | 🧹 teste automatizado |
| `lojaativa202610091503` | starter | active | teste |
| `gostinho-amor` | pro | active | real |
| `alves-distribuidora` | free | active | real |
| `teste2` | pro | trial | **manter** |
| `loave-teste-teste7092` | pro | active | 🧹 teste QA (contratação) |
| `loja-free-free5228` | free | active | 🧹 teste QA (plano grátis) |
| `loja-pix-pix7428` | pro | active | 🧹 teste QA (PIX) |

---

## 6. Pendências

### 🔴 Prioridade alta
1. **Chave PIX é fictícia.** A chave aleatória atual **não está registrada** em conta bancária — pagamentos reais não cairão. Trocar por CPF/CNPJ/e-mail verdadeiro via `PUT /api/super-admin/templates` (campo `pix_key`) ou pela aba Mensagens.
2. **Limpar lojas de teste de QA:** `loave-teste-teste7092`, `loja-free-free5228`, `loja-pix-pix7428` (criadas na validação do fluxo).

### 🟡 Opcional / backlog
3. Notificação por **e-mail** — exige SMTP no `.env` (hoje só existe navegador + WhatsApp).
4. **Renovação automática** — hoje cada ativação dá 30 dias; falta rotina de vencimento/suspensão automática.
5. Integração com gateway (Mercado Pago/Stripe) para dispensar a confirmação manual do admin.
6. Cupons de desconto e reembolso (`contratacao.txt` seção 6).

---

## 7. Arquivos principais

| Caminho | Papel |
|---|---|
| `services/contracting.js` | **novo** — toda a lógica de contratação |
| `services/provisioning.js` | criação transacional de tenant + admin user |
| `services/billing.js` | planos, MRR, `platformStats` (inclui `newLeads`) |
| `routes/super-admin.js` | painel da plataforma (tenants, pagamentos, leads, subscriptions, auditoria) |
| `middleware/tenantResolver.js` | whitelist `isTenantlessRoute` das rotas públicas |
| `js/super-admin.js` | front do painel (v13) |
| `pages/super-admin.html` | markup do painel (v13) |
| `pages/landing.html` | página de vendas + modais de contratação |
| `migrations/005_saas_leads.sql` | tabela de leads |
| `migrations/006_contracting.sql` | tabela de assinaturas |

---

## 8. Como retomar

Diga "continuar o relatório" e eu leio este arquivo para retomar do ponto exato.
Sugestão para amanhã: começar pelo item **1** (chave PIX real), depois o **2** (limpar QA).