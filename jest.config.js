/** Config do Jest para o SaaS de cardápio digital. */
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
// Testes nunca usam Redis: o rate limiter deve usar store em memória,
// para não poluir contadores compartilhados.
delete process.env.REDIS_URL;

module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  setupFiles: ['<rootDir>/tests/setup.js'],
  transform: {
    '^.+\\.jsx?$': 'babel-jest'
  },
  // uuid@14 é ESM-only; o Babel precisa transpilar para CJS dentro do Jest.
  transformIgnorePatterns: ['/node_modules/(?!(uuid)/)'],
  testMatch: ['**/*.test.js'],
  collectCoverageFrom: [
    'server.js',
    'js/**/*.js',
    'routes/**/*.js',
    'services/**/*.js',
    'middleware/**/*.js',
    'lib/**/*.js',
    '!**/node_modules/**'
  ],
  /* Ratchet: limiares ficam LOGO ABAIXO do coberto hoje (30.5% linhas,
     28.3% funções, 20.6% branches). A regra é: nova suíte só entra se
     também aumentá-los — cobertura nunca regride sem quebrar o CI. */
  coverageThreshold: {
    global: { lines: 30, functions: 28, branches: 20 }
  },
  testTimeout: 20000,
  forceExit: true,
  clearMocks: true,
  verbose: true
};
