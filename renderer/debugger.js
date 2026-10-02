(function() {
  const panel    = document.getElementById('gw-debug-panel');
  const logEl    = document.getElementById('gw-debug-log');
  const debugBtn = document.getElementById('debug-btn');
  const closeBtn = document.getElementById('gw-debug-close');
  const clearBtn = document.getElementById('gw-debug-clear');
  const copyBtn  = document.getElementById('gw-debug-copy');
  let logLines   = [];
  let isOpen     = false;

  // Hover effects (moved out of inline onmouseenter/onmouseleave to satisfy CSP)
  if (debugBtn) {
    debugBtn.addEventListener('mouseenter', () => { debugBtn.style.opacity = '1'; });
    debugBtn.addEventListener('mouseleave', () => { debugBtn.style.opacity = isOpen ? '1' : '0.55'; });
  }

  function show() {
    isOpen = true;
    panel.style.display = 'flex';
    debugBtn.style.opacity = '1';
    logEl.scrollTop = logEl.scrollHeight;
  }
  function hide() {
    isOpen = false;
    panel.style.display = 'none';
    debugBtn.style.opacity = '0.55';
  }

  if (debugBtn) debugBtn.addEventListener('click', (e) => { e.stopPropagation(); isOpen ? hide() : show(); });
  if (closeBtn) closeBtn.addEventListener('click', (e) => { e.stopPropagation(); hide(); });
  if (clearBtn) clearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    logEl.innerHTML = '';
    logLines = [];
  });
  if (copyBtn) copyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const text = logLines.join('\n');
    navigator.clipboard.writeText(text).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
    });
    copyBtn.textContent = 'Copied!';
    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
  });

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function appendLog(level, args) {
    const ts = new Date().toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
    const text = args.map(a => {
      if (a instanceof Error) return a.message;
      return typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a);
    }).join(' ');
    const colors = { log:'#d4d4d4', warn:'#fbbf24', error:'#f87171', info:'#60a5fa' };
    const icons  = { log:'&middot;', warn:'&#9888;', error:'&#10005;', info:'&#9432;' };
    const div = document.createElement('div');
    div.style.cssText = `padding:2px 0;border-bottom:1px solid rgba(255,255,255,0.04);color:${colors[level]||'#d4d4d4'};word-break:break-word;`;
    div.innerHTML = `<span style="opacity:0.45;">${ts}</span> <span>${icons[level]||'&middot;'}</span> ${escHtml(text)}`;
    logEl.appendChild(div);
    logLines.push(`[${ts}][${level.toUpperCase()}] ${text}`);
    if (logLines.length > 600) { logLines.shift(); if (logEl.firstChild) logEl.removeChild(logEl.firstChild); }
    if (isOpen) logEl.scrollTop = logEl.scrollHeight;
  }

  // Intercept console
  const orig = {};
  ['log','warn','error','info'].forEach(lvl => {
    orig[lvl] = console[lvl].bind(console);
    console[lvl] = (...a) => { orig[lvl](...a); appendLog(lvl, a); };
  });

  window.addEventListener('error', e =>
    appendLog('error', [`Uncaught: ${e.message} (${e.filename}:${e.lineno})`]));
  window.addEventListener('unhandledrejection', e =>
    appendLog('error', [`Promise rejected: ${e.reason}`]));

  // Listen to IPC events forwarded from main process
  if (window.ghostwolf && window.ghostwolf.on) {
    window.ghostwolf.on('status',    d => appendLog('info',  ['[status]',    d && d.message || JSON.stringify(d)]));
    window.ghostwolf.on('stt:error', d => appendLog('error', ['[stt:error]', d && d.message || JSON.stringify(d)]));
  }

  appendLog('info', ['Debugger ready — click \uD83D\uDC1E to open/close']);
})();
