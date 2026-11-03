/* CardapioDigital - 404 fallback (extraido de 404.html) */
/* GitHub Pages não tem rotas: qualquer caminho que não exista (por exemplo
     /acompanhar, que é o link de rastreio que o cliente recebe) devolve este
     404.html. Aqui devolvemos a pessoa para o index.html PRESERVANDO ?c=CODIGO
     e a hash — senão o cliente perderia o código do pedido.

     A pasta base do site não é fixa: pode ser "/" (github.io/usuario) ou
     "/repo/" (github.io/usuario/repo). Em vez de adivinhar, testamos da raiz
     para fora e usamos o primeiro index.html que responder 200. Isso também
     impede loop de redirect: só redirecionamos depois de achar um destino
     que realmente existe. */
  (function () {
    var link = document.getElementById('voltar');
    var aviso = document.getElementById('erro');

    function mostrarSemRedirecionar(destino) {
      if (destino) link.href = destino;
      aviso.style.display = 'block';
    }

    if (typeof fetch !== 'function') { mostrarSemRedirecionar(); return; }

    var partes = location.pathname.split('/').filter(Boolean);
    var sufixo = location.search + location.hash;
    var tentativas = [];

    /* Do mais específico para o mais geral: num site de projeto a base é
       /repo/, e é exatamente esse o que queremos achar (/repo/index.html) —
       antes de qualquer index.html que existisse acima dele. */
    for (var i = partes.length; i >= 0; i--) {
      var base = partes.slice(0, i);
      tentativas.push('/' + base.join('/') + (base.length ? '/' : '') + 'index.html');
    }

    (function tentar(idx) {
      if (idx >= tentativas.length) { mostrarSemRedirecionar(tentativas[tentativas.length - 1]); return; }
      var destino = tentativas[idx];
      fetch(destino, { method: 'HEAD', cache: 'no-store' })
        .then(function (r) { if (r.ok) location.replace(destino + sufixo); else tentar(idx + 1); })
        .catch(function () { tentar(idx + 1); });
    })(0);
  })();
