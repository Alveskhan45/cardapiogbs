const js = require('@eslint/js');
const security = require('eslint-plugin-security');
const noUnsanitized = require('eslint-plugin-no-unsanitized');

/* Três faixas de arquivo, cada uma com suas regras:

   1) servidor   (server.js, middleware, routes, services, db, lib)
                 Node puro, strict total (no-undef e no-unused-vars valem).
   2) browser    (js/**) — scripts concatenados e carregados como <script>
                 clássicos: símbolos de um arquivo são globais nos outros,
                 então no-undef/no-unused-vars gerariam milhares de falsos
                 positivos. Ficam DESLIGADOS aqui; o que importa nessa faixa
                 são as regras de XSS (no-unsanitized) e as de segurança.
   3) teste/config (tests, scripts, *.config.js) — Node + globais do Jest.
*/
const SERVER_FILES = ['server.js', 'middleware/**/*.js', 'routes/**/*.js', 'services/**/*.js', 'db/**/*.js', 'lib/**/*.js'];
const TEST_FILES = ['tests/**/*.js', 'scripts/**/*.js', 'eslint.config.js', 'jest.config.js', 'babel.config.js'];

const SECURITY_RULES = {
  'security/detect-object-injection': 'warn',
  'security/detect-non-literal-fs-filename': 'warn',
  'security/detect-eval-with-expression': 'warn',
  'security/detect-possible-timing-attacks': 'warn'
};

const NODE_GLOBALS = {
  console: 'readonly', process: 'readonly', require: 'readonly', module: 'readonly',
  __dirname: 'readonly', __filename: 'readonly', Buffer: 'readonly',
  fetch: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
  crypto: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly',
  FormData: 'readonly', Headers: 'readonly', Request: 'readonly', Response: 'readonly',
        AbortController: 'readonly', structuredClone: 'readonly', queueMicrotask: 'readonly',
        Blob: 'readonly', File: 'readonly', FormData: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly'
};

module.exports = [
  js.configs.recommended,

  /* ---------- 1) código de servidor ---------- */
  {
    files: SERVER_FILES,
    plugins: { security, 'no-unsanitized': noUnsanitized },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: NODE_GLOBALS
    },
    rules: { ...SECURITY_RULES }
  },

  /* ---------- 2) código de browser (scripts concatenados) ---------- */
  {
    files: ['js/**/*.js'],
    plugins: { security, 'no-unsanitized': noUnsanitized },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...NODE_GLOBALS,
        window: 'readonly', document: 'readonly', navigator: 'readonly',
        location: 'readonly', localStorage: 'readonly', sessionStorage: 'readonly',
        alert: 'readonly', confirm: 'readonly', prompt: 'readonly',
        EventSource: 'readonly', AudioContext: 'readonly', webkitAudioContext: 'readonly',
        QRCode: 'readonly', Notification: 'readonly', Image: 'readonly',
        Blob: 'readonly', FileReader: 'readonly', XMLHttpRequest: 'readonly',
        btoa: 'readonly', atob: 'readonly'
      }
    },
    rules: {
      // símbolos vêm de outros <script> da mesma página: não dá para
      // validar escopo/undefined por arquivo sem quebrar tudo
      'no-undef': 'off',
      'no-unused-vars': 'off',
      'no-empty': 'off',
      // o que realmente interessa no browser: XSS e injeção
      ...SECURITY_RULES,
      'no-unsanitized/method': 'warn',
      'no-unsanitized/property': 'warn'
    }
  },

  /* ---------- 3) testes, scripts e configs ---------- */
  {
    files: TEST_FILES,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...NODE_GLOBALS,
        describe: 'readonly', it: 'readonly', test: 'readonly',
        expect: 'readonly', beforeAll: 'readonly', afterAll: 'readonly',
        beforeEach: 'readonly', afterEach: 'readonly', jest: 'readonly'
      }
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }]
    }
  },

  {
    ignores: ['node_modules/**', 'js/vendor/**', '*.min.js', 'package-lock.json', 'coverage/**']
  }
];
