// Shared rendering for the Dovun icon review pages. A page lists its rows, then calls IconReview.render(rows).
// Each row: { name, mark, dark, badge, mono, white, bitmap }. bitmap is a path prefix ending before "16.png";
// it may contain {tile}, which the page's tile buttons (data-tile) switch. Grids missing from a page are skipped.
(() => {
  const mark = (src, size) => `<img src="${src}" width="${size}" height="${size}" alt="">`;
  const sizes = [16, 24, 32, 48];

  const sections = {
    'small-grid': row => `
      <div class="cell warm">${sizes.map(size => mark(row.mark, size)).join('')}</div>
      <div class="cell dark">${sizes.map(size => mark(row.dark, size)).join('')}</div>
      <div class="cell light"><img class="pixel" data-src="${row.bitmap}16.png" alt=""><img class="pixel big" data-src="${row.bitmap}32.png" alt=""></div>`,
    'inapp-grid': row => `<div>${inApp(row.mark)}</div><div class="dark">${inApp(row.dark)}</div>`,
    'tab-grid': row => `<div class="cell warm" style="display:block;padding:12px">${tab('light', row.mark)}</div><div class="cell dark" style="display:block;padding:12px">${tab('dark', row.dark)}</div>`,
    'badge-grid': row => `
      <div class="cell dark"><div class="statusbar"><span class="time">9:41</span><img src="${row.badge}" alt=""><span class="other"></span><span class="other"></span></div></div>
      <div class="cell dark"><div class="shade"><span class="badge-circle"><img src="${row.badge}" alt=""></span><div><b>Dovun</b><span>今天 3 项任务到期</span></div></div></div>`,
    'mono-grid': row => `
      <div class="cell light">${mark(row.mono, 64)}${mark(row.mono, 24)}</div>
      <div class="cell" style="background:#354d85">${mark(row.white, 64)}${mark(row.white, 24)}</div>`,
  };

  // Uses the app's own .dovun-brand, .dovun-companion-brand and .dovun-assistant-welcome rules (workbench.css).
  function inApp(src) {
    return `
      <div class="mock sidebar">
        <div class="dovun-brand"><img src="${src}" class="dovun-brand-symbol" alt=""><strong>dovun</strong></div>
        <div class="compact-rail"><div class="dovun-brand"><img src="${src}" class="dovun-brand-symbol" alt=""></div><small>收起</small></div>
      </div>
      <div class="mock companion" style="margin-top:10px"><div class="dovun-companion-brand"><img src="${src}" alt=""><div><h2>Dovun 工作助手</h2><p>一起把工作往前推。</p></div></div></div>
      <div class="mock welcome" style="margin-top:10px"><div class="dovun-assistant-welcome"><img src="${src}" alt=""><h3>Dovun 工作助手</h3><p>一起把工作往前推。</p></div></div>`;
  }

  function tab(theme, src) {
    return `
      <div class="tabwrap ${theme}"><div class="tabbar ${theme}">
        <div class="tab on"><img src="${src}" width="16" height="16" alt=""><span>Dovun</span></div>
        <div class="tab off"><span class="dot"></span><span>其他页面</span></div>
      </div><div class="page-strip"></div></div>`;
  }

  function bindTiles() {
    const buttons = document.querySelectorAll('button[data-tile]');
    const known = [...buttons].map(button => button.dataset.tile);
    const asked = new URLSearchParams(location.hash.slice(1)).get('tile');
    let tile = known.includes(asked) ? asked : known[0] ?? '';
    const apply = () => {
      for (const img of document.querySelectorAll('img[data-src]')) img.src = img.dataset.src.replace('{tile}', tile);
      for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.tile === tile));
      if (buttons.length) {
        try { history.replaceState(null, '', '#tile=' + tile); } catch { /* some browsers block this on file:// */ }
      }
    };
    for (const button of buttons) button.addEventListener('click', () => { tile = button.dataset.tile; apply(); });
    apply();
  }

  window.IconReview = {
    render(rows) {
      for (const [id, render] of Object.entries(sections)) {
        const grid = document.getElementById(id);
        if (!grid) continue;
        for (const row of rows) grid.insertAdjacentHTML('beforeend', `<div class="label">${row.name}</div>` + render(row));
      }
      bindTiles();
    },
  };
})();
