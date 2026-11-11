/* CardapioDigital - inicializacao de tema.
   Forca sempre o tema claro (modo escuro desativado). */
(function () {
  try {
    localStorage.removeItem('bebidas_cardapio_v6_theme');
  } catch (e) {}
  document.documentElement.setAttribute('data-theme', 'light');
})();
