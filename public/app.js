(() => {
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = false;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`Não foi possível carregar ${src}`));
      document.head.appendChild(script);
    });
  }

  async function start() {
    try {
      await loadScript('/app-core.js');
      await loadScript('/app-features.js');
      if (typeof boot === 'function') await boot();
    } catch (error) {
      console.error(error);
      document.body.innerHTML = '<main style="min-height:100vh;display:grid;place-items:center;background:#090909;color:#fff;font-family:system-ui;padding:24px;text-align:center"><div><strong>GTRZ Flow não conseguiu iniciar.</strong><p style="color:#999">Recarregue a página ou confira os assets do deploy.</p></div></main>';
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
