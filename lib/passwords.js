// @ts-check
/* ============================================================
   lib/passwords.js — hash/verificação de senha (scrypt nativo)
   Mesma receita do server.js original: hashes "scrypt$" seguem
   valendo (migração de dados legado preserva as senhas antigas).
   ============================================================ */
'use strict';

const crypto = require('crypto');

/**
 * Gera o hash scrypt de uma senha (sal aleatório de 16 bytes).
 * @param {string} pass senha em texto plano
 * @returns {string} hash no formato `scrypt$<sal>$<derivada>`
 */
function hashPass(pass) {
  const salt = crypto.randomBytes(16).toString('hex');
  const buf = crypto.scryptSync('bebidas::' + (pass || ''), salt, 64);
  return 'scrypt$' + salt + '$' + buf.toString('hex');
}

/**
 * Compara uma senha com o hash armazenado em tempo constante.
 * Aceita os formatos legados `sha256$` e texto plano (migração).
 * @param {string} pass senha informada
 * @param {string | null | undefined} stored hash gravado no banco
 * @returns {boolean} true se a senha confere
 */
function verifyPass(pass, stored) {
  const s = stored || '';
  if (!s) return false;
  if (s.startsWith('scrypt$')) {
    const parts = s.split('$');
    const salt = parts[1];
    const expected = Buffer.from(parts[2], 'hex');
    const got = crypto.scryptSync('bebidas::' + (pass || ''), salt, expected.length);
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  }
  if (s.startsWith('sha256$')) {
    const expected = Buffer.from(s.slice(7), 'hex');
    const got = Buffer.from(crypto.createHash('sha256').update('bebidas::' + (pass || '')).digest('hex'), 'hex');
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  }
  return s === pass;
}

/**
 * Indica se o hash gravado usa formato antigo e precisa ser regerado.
 * @param {string | null | undefined} stored hash gravado no banco
 * @returns {boolean} true quando NÃO é scrypt
 */
function passwordNeedsMigration(stored) {
  return !(stored || '').startsWith('scrypt$');
}

/* Senha forte e aleatória (sem padrão: a app gera na primeira vez/provisionamento) */

/**
 * Gera senha aleatória sem caracteres ambíguos (0/O, 1/l/I).
 * @param {number} [len] tamanho desejado (padrão 16)
 * @returns {string} senha aleatória alfanumérica
 */
function generatePassword(len = 16) {
  const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (const b of bytes) out += chars[b % chars.length];
  return out;
}

/* Valida força da senha: mínimo 8 chars, maiúscula, minúscula, número, especial opcional */

/**
 * Aplica as 4 regras de força (8+ chars, minúscula, maiúscula, número).
 * @param {string} pass senha a validar
 * @returns {{ valid: boolean, errors: string[] }} resultado e a lista de regras que falharam
 */
function validatePasswordStrength(pass) {
  const errors = [];
  if (!pass || pass.length < 8) errors.push('Mínimo 8 caracteres');
  if (!/[a-z]/.test(pass)) errors.push('Pelo menos uma letra minúscula');
  if (!/[A-Z]/.test(pass)) errors.push('Pelo menos uma letra maiúscula');
  if (!/[0-9]/.test(pass)) errors.push('Pelo menos um número');
  return { valid: errors.length === 0, errors };
}

module.exports = { hashPass, verifyPass, passwordNeedsMigration, generatePassword, validatePasswordStrength };
