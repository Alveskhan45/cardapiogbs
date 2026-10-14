/* ============================================================
   lib/seed.js — dados de exemplo e config padrão de um tenant
   (extraído do seed do server.js single-tenant; usado no
   provisionamento de novos tenants e como fallback)
   ============================================================ */
'use strict';

const uid = () => '_' + Math.random().toString(36).slice(2, 9);

/* Config padrão de uma loja nova (1:1 por tenant, tabela config) */
function defaultConfig(overrides = {}) {
  return Object.assign(
    {
      storeName: 'Minha Distribuidora',
      slogan: 'Sua loja de bebidas',
      whatsapp: '',
      phone: '',
      instagram: '',
      address: '',
      minOrder: 15,
      deliveryTime: '30-45 min',
      soundAlert: true,
      notifyWpp: false,
      openTime: '18:00',
      closeTime: '23:00',
      days: 'Seg, Ter, Qua, Qui, Sex, Sáb, Dom',
      hours: 'Seg-Dom 18h-23h',
      freteMode: 'fixo',
      freteFixo: 5,
      freteKmVal: 2.5,
      freteKmGratis: 0,
      freteGratisAcima: 0,
      storeCoords: '',
      storeZip: '',
      storeStreet: '',
      storeNumber: '',
      storeDistrict: '',
      storeCity: '',
      storeBanner: '',
      payments: ['Pix', 'Dinheiro', 'Cartão na entrega'],
      pix: '',
      pixName: '',
      pixCity: '',
      requireAge: false,
      blockWhenClosed: false,
      minStock: 5,
      blockOutOfStock: false,
      showBanner: true,
      bannerShape: 'square',
      storeLogo: '',
      buttonShape: 'round',
      colorPrimary: '#ff5c39',
      colorPrimaryDark: '#e03e1f',
      themeAccent: '#ffd166',
      themeId: 'coral',
      autoBackup: true,
      lastAutoBackup: 0
    },
    overrides
  );
}

/* Produtos de exemplo (Fase 6.3 — dados demo no onboarding) */
function demoProducts() {
  return [
    { id: uid(), name: 'Coca-Cola', desc: 'Refrigerante gelado', price: 6.0, promoPrice: null, cost: 2.5, category: 'Refrigerantes', stock: 40, image: '🥤', highlight: true, promo: false, active: true,
      variations: [{ name: 'Lata 350ml', price: 0 }, { name: 'PET 600ml', price: 2 }, { name: '2 Litros', price: 6 }],
      extras: [{ name: 'Copo com gelo', price: 1 }, { name: 'Limão extra', price: 0.5 }] },
    { id: uid(), name: 'Guaraná Antarctica', desc: 'Garrafa família', price: 12.0, promoPrice: 9.9, cost: 6, category: 'Refrigerantes', stock: 25, image: '🥤', highlight: false, promo: true, active: true,
      variations: [{ name: '1 Litro', price: 0 }, { name: '2 Litros', price: 3 }], extras: [] },
    { id: uid(), name: 'Suco de Laranja Natural', desc: 'Espremido na hora', price: 10.0, promoPrice: null, cost: 4, category: 'Sucos', stock: 15, image: '🍊', highlight: true, promo: false, active: true,
      variations: [{ name: '500ml', price: 0 }, { name: '1 Litro', price: 5 }], extras: [] },
    { id: uid(), name: 'Heineken Long Neck', desc: '330ml, bem gelada', price: 9.9, promoPrice: null, cost: 5, category: 'Cervejas', stock: 24, image: '🍺', highlight: false, promo: false, active: true,
      variations: [{ name: 'Unidade', price: 0 }, { name: 'Pack 6', price: 45 }], extras: [{ name: 'Copo', price: 1 }] },
    { id: uid(), name: 'Brahma Lata', desc: '350ml, gelada', price: 5.0, promoPrice: 4.5, cost: 2.5, category: 'Cervejas', stock: 40, image: '🍺', highlight: false, promo: true, active: true, variations: [], extras: [] },
    { id: uid(), name: 'Água Mineral', desc: 'Sem gás, gelada', price: 3.0, promoPrice: null, cost: 1, category: 'Águas', stock: 50, image: '💧', highlight: false, promo: false, active: true,
      variations: [{ name: '500ml', price: 0 }, { name: '1,5 Litro', price: 3 }], extras: [] }
  ];
}

function demoCategories() {
  return ['Refrigerantes', 'Sucos', 'Águas', 'Cervejas', 'Energéticos', 'Vinhos'];
}

function demoBairros() {
  return [
    { id: uid(), name: 'Centro', tax: 5, km: 2 },
    { id: uid(), name: 'Jardim Gurilândia', tax: 8, km: 4 },
    { id: uid(), name: 'Vila Nova', tax: 12, km: 7 }
  ];
}

function demoCoupons() {
  return [
    { id: uid(), code: 'BEMVINDO10', type: 'percent', value: 10, min: 20, active: true, uses: 0, limit: 0, per: 0, first: false },
    { id: uid(), code: 'FRETE5', type: 'fixed', value: 5, min: 30, active: true, uses: 0, limit: 0, per: 0, first: false }
  ];
}

/* Estado inicial completo (sem pedidos) */
function demoState(storeName) {
  return {
    products: demoProducts(),
    orders: [],
    coupons: demoCoupons(),
    categories: demoCategories(),
    bairros: demoBairros(),
    adminLog: [],
    stockLog: [],
    config: defaultConfig(storeName ? { storeName } : {})
  };
}

module.exports = { defaultConfig, demoProducts, demoCategories, demoBairros, demoCoupons, demoState, uid };
