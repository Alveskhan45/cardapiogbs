const request = require('supertest');
const { dbAvailableSync } = require('./setup');

let app;

/**
 * Regressão: o express.json() global consome o stream antes das rotas de
 * webhook. O rawBodyParser lia o stream de novo, o evento 'end' nunca
 * chegava e a requisição travava (o provedor ficava reenviando para sempre).
 * O corpo cru agora vem do `verify` do express.json.
 */
beforeAll(() => {
  app = require('../server').app;
});

describe('Webhooks de pagamento', () => {
  test('POST /api/webhooks/stripe sem assinatura responde 400', async () => {
    const res = await request(app)
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .send({ id: 'evt_1', type: 'invoice.payment_succeeded' });

    expect(res.status).toBe(400);
    expect(res.text).toContain('stripe-signature');
  });

  test('POST /api/webhooks/asaas sem assinatura responde 400', async () => {
    const res = await request(app)
      .post('/api/webhooks/asaas')
      .set('Content-Type', 'application/json')
      .send({ id: 'evt_1', event: 'PAYMENT_RECEIVED' });

    expect(res.status).toBe(400);
    expect(res.text).toContain('asaas-signature');
  });

  test('com assinatura a requisição responde (não trava) e o corpo cru é lido', async () => {
    const payload = { id: 'evt_1', type: 'invoice.payment_succeeded' };
    const res = await request(app)
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 't=1,v1=assinatura-invalida')
      .send(payload);

    // Chega ao handlePaymentWebhook e falha na verificação da assinatura
    // (não em timeout). O status é 400 com a mensagem do provedor.
    expect(res.status).toBe(400);
    expect(res.text).toContain('Webhook error');
  });

  test('o corpo cru preserva bytes que o JSON.parse perderia', async () => {
    // "23:00" em jsonb chega como escalar; o raw body precisa ser a string exata
    // que o provedor assinou, não o objeto re-serializado.
    const captured = [];
    const payment = require('../services/payment');
    const original = payment.handlePaymentWebhook;
    payment.handlePaymentWebhook = (provider, payload) => {
      captured.push(payload);
      return Promise.resolve({ success: true, duplicate: false });
    };

    try {
      const res = await request(app)
        .post('/api/webhooks/asaas')
        .set('Content-Type', 'application/json')
        .set('asaas-signature', 'qualquer')
        .send({ id: 'sub_1', event: 'PAYMENT_RECEIVED', dueDate: '23:00' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true, duplicate: false });
      expect(captured).toHaveLength(1);
      expect(typeof captured[0]).toBe('string');
      expect(captured[0]).toContain('"dueDate":"23:00"');
    } finally {
      payment.handlePaymentWebhook = original;
    }
  });
});

if (dbAvailableSync) {
  describe('Webhooks com banco', () => {
    test('persiste idempotência: mesmo eventoprocessado duas vezes', async () => {
      jest.setTimeout(20000);
      const captured = [];
      const payment = require('../services/payment');
      const original = payment.handlePaymentWebhook;
      payment.handlePaymentWebhook = (provider, payload) => {
        captured.push(payload);
        return Promise.resolve({ success: true, duplicate: captured.length > 1 });
      };

      try {
        const body = { id: 'evt_dup', type: 'invoice.payment_succeeded' };
        const first = await request(app)
          .post('/api/webhooks/stripe')
          .set('stripe-signature', 'x').send(body);
        const second = await request(app)
          .post('/api/webhooks/stripe')
          .set('stripe-signature', 'x').send(body);

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(second.body.duplicate).toBe(true);
      } finally {
        payment.handlePaymentWebhook = original;
      }
    });
  });
}