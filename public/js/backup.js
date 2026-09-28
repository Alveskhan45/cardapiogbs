/* ==================== BACKUP / RESTORE ==================== */
document.addEventListener('DOMContentLoaded', () => {
  const btnBackup = $('btnBackup');
  if (btnBackup) btnBackup.onclick = async () => {
    const zip = new JSZip();
    zip.file('dados.json', JSON.stringify(state, null, 2));
    zip.file('LEIA-ME.txt',
      'Backup do cardápio de produtos.\n\n' +
      'Para usar imagens locais:\n' +
      '1. Crie a pasta "assets" com suas fotos\n' +
      '2. No cadastro do produto, use "assets/nome-da-foto.jpg"\n');
    const folder = zip.folder('assets');
    folder.file('coloque-suas-fotos-aqui.txt', 'Salve as fotos nesta pasta e use "assets/nome.jpg" no cadastro.');
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `backup-produtos-${new Date().toISOString().slice(0,10)}.zip`;
    a.click(); URL.revokeObjectURL(url);
    toast('💾 Backup gerado');
  };

  const btnRestore = $('btnRestore');
  if (btnRestore) btnRestore.onclick = () => $('fileRestore').click();

  const fileRestore = $('fileRestore');
  if (fileRestore) fileRestore.onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const zip = await JSZip.loadAsync(f);
      const j = zip.file('dados.json');
      if (!j) { toast('dados.json não encontrado'); return; }
      state = { ...state, ...JSON.parse(await j.async('string')) };
      save(); renderCats(); renderCart(); renderAdmin();
      toast('✅ Backup restaurado!');
    } catch(err) { toast('Erro: ' + err.message); }
    e.target.value = '';
  };
});