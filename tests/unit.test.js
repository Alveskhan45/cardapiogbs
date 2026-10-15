/* Testes unitários das funções puras — sem banco, sem rede. */
'use strict';

const {
  hashPass, verifyPass, passwordNeedsMigration,
  generatePassword, validatePasswordStrength
} = require('../lib/passwords');
const { slugify, validate } = require('../services/provisioning');
const { normalize, candidateIdentifiers } = require('../middleware/tenantResolver');
const { calcItemPrice, calcFreight } = require('../server');

describe('lib/passwords', () => {
  test('hashPass + verifyPass fecha o ciclo', () => {
    const h = hashPass('SenhaForte123');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(verifyPass('SenhaForte123', h)).toBe(true);
  });

  test('verifyPass rejeita senha errada', () => {
    const h = hashPass('SenhaForte123');
    expect(verifyPass('SenhaErrada123', h)).toBe(false);
    expect(verifyPass('', h)).toBe(false);
  });

  test('mesma senha gera hashes diferentes (sal aleatório por hash)', () => {
    expect(hashPass('SenhaForte123')).not.toBe(hashPass('SenhaForte123'));
  });

  test('verifyPass aceita hash legado sha256 (migração preservada)', () => {
    const crypto = require('crypto');
    const legacy = 'sha256$' + crypto.createHash('sha256').update('bebidas::admin123').digest('hex');
    expect(verifyPass('admin123', legacy)).toBe(true);
    expect(passwordNeedsMigration(legacy)).toBe(true);
    expect(passwordNeedsMigration(hashPass('admin123'))).toBe(false);
  });

  test('verifyPass com hash vazio ou plano retorna erro de forma segura', () => {
    expect(verifyPass('qualquer', '')).toBe(false);
    expect(verifyPass('qualquer', null)).toBe(false);
  });

  test('generatePassword respeita tamanho e alfabeto', () => {
    const p = generatePassword(16);
    expect(p).toHaveLength(16);
    expect(p).toMatch(/^[a-zA-Z0-9]{16}$/);
    expect(generatePassword(24)).toHaveLength(24);
  });

  test('validatePasswordStrength aplica as 4 regras', () => {
    expect(validatePasswordStrength('SenhaForte123').valid).toBe(true);
    expect(validatePasswordStrength('curta').valid).toBe(false);
    expect(validatePasswordStrength('semmaiuscula1').errors).toContain('Pelo menos uma letra maiúscula');
    expect(validatePasswordStrength('SEMMINUSCULA1').errors).toContain('Pelo menos uma letra minúscula');
    expect(validatePasswordStrength('SemNumero').errors).toContain('Pelo menos um número');
  });
});

describe('server: calcItemPrice', () => {
  test('preço base sem variação nem extra', () => {
    expect(calcItemPrice({ price: 10 }, null, [])).toBe(10);
  });

  test('promoPrice substitui o preço base', () => {
    expect(calcItemPrice({ price: 10, promo: true, promoPrice: 8 }, null, [])).toBe(8);
  });

  test('variação é ADITIVA (+R$), não absoluta', () => {
    expect(calcItemPrice({ price: 9.9 }, { price: 45 }, [])).toBeCloseTo(54.9, 5);
  });

  test('variação de R$ 0 não zera o item', () => {
    expect(calcItemPrice({ price: 30 }, { price: 0 }, [])).toBe(30);
  });

  test('extras somam ao preço', () => {
    expect(calcItemPrice({ price: 20 }, null, [{ price: 3 }, { price: 2.5 }])).toBe(25.5);
  });

  test('extras com preço inválido são ignorados', () => {
    expect(calcItemPrice({ price: 20 }, null, [{ price: null }, {}])).toBe(20);
  });
});

describe('server: calcFreight', () => {
  const cfg = (o = {}) => ({ freteMode: 'fixo', freteFixo: 8, freteGratisAcima: 0, freteKmGratis: 0, ...o });

  test('Retirada é sempre grátis', () => {
    expect(calcFreight(500, { type: 'Retirada' }, cfg(), [])).toBe(0);
  });

  test('freteGratisAcima zera o frete', () => {
    expect(calcFreight(100, { type: 'Entrega' }, cfg({ freteGratisAcima: 100 }), [])).toBe(0);
    expect(calcFreight(99, { type: 'Entrega' }, cfg({ freteGratisAcima: 100 }), [])).toBe(8);
  });

  test('modo fixo usa freteFixo', () => {
    expect(calcFreight(50, { type: 'Entrega' }, cfg({ freteFixo: 12 }), [])).toBe(12);
  });

  test('modo gratis zera em qualquer valor', () => {
    expect(calcFreight(50, { type: 'Entrega' }, cfg({ freteMode: 'gratis' }), [])).toBe(0);
  });

  test('modo km calcula por quilômetro', () => {
    expect(calcFreight(50, { type: 'Entrega', km: 4 }, cfg({ freteMode: 'km', freteKmVal: 2 }), [])).toBe(8);
  });

  test('modo km respeita freteKmGratis', () => {
    expect(calcFreight(50, { type: 'Entrega', km: 5 }, cfg({ freteMode: 'km', freteKmVal: 2, freteKmGratis: 5 }), [])).toBe(0);
  });

  test('modo bairro usa a taxa do bairro', () => {
    const bairros = [{ id: 'centro', tax: 6 }];
    expect(calcFreight(50, { type: 'Entrega', bairroId: 'centro' }, cfg({ freteMode: 'bairro' }), bairros)).toBe(6);
    expect(calcFreight(50, { type: 'Entrega', bairroId: 'nao-existe' }, cfg({ freteMode: 'bairro' }), bairros)).toBe(0);
  });
});

describe('provisioning: slugify', () => {
  test('remove acentos, caixa alta e símbolos', () => {
    expect(slugify('AÇAÍ & Bebidas do Alves!')).toBe('acai-bebidas-do-alves');
  });
  test('colapsa separadores e tira hífens das pontas', () => {
    expect(slugify('  ---Minha   Loja--- ')).toBe('minha-loja');
  });
  test('trabalha com entrada vazia', () => {
    expect(slugify('')).toBe('');
    expect(slugify(null)).toBe('');
  });
});

describe('provisioning: validate', () => {
  const base = {
    name: 'Loja Teste', subdomain: 'loja-teste', adminEmail: 'adm@exemplo.com', plan: 'starter'
  };

  test('payload válido não gera erros', () => {
    const { errors } = validate(base);
    expect(errors).toEqual([]);
  });

  test('nome é obrigatório', () => {
    expect(validate({ ...base, name: '' }).errors).toContain('Nome do tenant é obrigatório');
  });

  test('subdomínio reservado é rejeitado', () => {
    expect(validate({ ...base, subdomain: 'admin' }).errors.some(e => /reservado/i.test(e))).toBe(true);
  });

  test('e-mail do admin inválido é rejeitado', () => {
    expect(validate({ ...base, adminEmail: 'nao-e-email' }).errors).toContain('E-mail do admin inválido');
  });

  test('plano inválido é rejeitado', () => {
    expect(validate({ ...base, plan: 'gold' }).errors).toContain('Plano inválido');
  });

  test('plano free nasce em trial', () => {
    expect(validate({ ...base, plan: 'free' }).values.status).toBe('trial');
  });

  test('planos pagos nascem em pending_approval', () => {
    expect(validate({ ...base, plan: 'starter' }).values.status).toBe('pending_approval');
    expect(validate({ ...base, plan: 'pro' }).values.status).toBe('pending_approval');
  });

  test('senha inicial curta é rejeitada', () => {
    expect(validate({ ...base, adminPassword: '123' }).errors).toContain('A senha inicial deve ter entre 8 e 128 caracteres');
  });

  test('cor primária fora do formato #rrggbb é rejeitada', () => {
    expect(validate({ ...base, primaryColor: 'vermelho' }).errors).toContain('Cor primária inválida');
  });
});

describe('tenantResolver: normalize', () => {
  test('slug válido passa em minúsculo', () => {
    expect(normalize('Loja-Teste')).toBe('loja-teste');
  });
  test('UUID é preservado', () => {
    const u = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    expect(normalize(u)).toBe(u);
  });
  test('caracteres inválidos retornam null', () => {
    expect(normalize('loja_teste')).toBeNull();
    expect(normalize('loja teste')).toBeNull();
    expect(normalize('-loja')).toBeNull();
    expect(normalize('a')).toBeNull();
  });
  test('mais de 100 caracteres retorna null', () => {
    expect(normalize('a'.repeat(101))).toBeNull();
  });
  test('vazio retorna null', () => {
    expect(normalize('')).toBeNull();
    expect(normalize(undefined)).toBeNull();
  });
});

describe('tenantResolver: candidateIdentifiers (modo auto)', () => {
  test('lê ?tenant=, header X-Tenant-ID e host', () => {
    const req = {
      path: '/api/login',
      query: { tenant: 'loja-x' },
      get: (h) => {
        if (h === 'x-tenant-id') return 'outro-tenant';
        if (h === 'host') return 'localhost';
        return undefined;
      }
    };
    const ids = candidateIdentifiers(req);
    expect(ids).toContain('loja-x');
    expect(ids).toContain('outro-tenant');
    expect(ids).not.toContain('localhost'); // host == WILDCARD_DOMAIN não é subdomínio
  });

  test('sem identificadores não retorna candidatos', () => {
    const req = {
      path: '/api/login',
      query: {},
      get: (h) => (h === 'host' ? 'localhost' : undefined)
    };
    expect(candidateIdentifiers(req)).toEqual([]);
  });

  test('extrai o tenant do path /t/:slug', () => {
    const req = {
      path: '/t/minha-loja/cardapio',
      query: {},
      get: (h) => (h === 'host' ? 'localhost' : undefined)
    };
    expect(candidateIdentifiers(req)).toEqual(['minha-loja']);
  });

  test('subdomínio do host é priorizado (loja.localhost)', () => {
    const req = {
      path: '/api/login',
      query: {},
      get: (h) => (h === 'host' ? 'loja-no-host.localhost:3001' : undefined)
    };
    expect(candidateIdentifiers(req)).toEqual(['loja-no-host']);
  });
});
