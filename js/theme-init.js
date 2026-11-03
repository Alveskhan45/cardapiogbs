/* CardapioDigital - inicializacao de tema (extraido de index.html).
   Roda no <head> para aplicar o tema antes do primeiro paint. */
(function () {
  try {
    var t = localStorage.getItem('bebidas_cardapio_v6_theme') || 'light';
    document.documentElement.setAttribute('data-theme', t);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();
