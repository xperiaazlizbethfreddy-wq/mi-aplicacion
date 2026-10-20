'use strict';
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === false || v == null) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const fmt = (s) => {
    s = Math.max(0, Math.floor(Number(s) || 0));
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
  };

  const S = {
    queue: [], queueRev: -1, currentId: null, nextId: null, currentIndex: -1,
    status: 'idle', wantPlaying: false, error: null, volume: 80, muted: false,
    repeat: 'off', autoplay: true, position: 0, duration: 0,
    displayReady: false, displayOnline: true, displayOpen: false, displayFullscreen: false, presentation: false,
    displays: [], library: { playlists: [], history: [], settings: { shortcuts: {} } },
    selectedId: null, filter: 'all', search: ''
  };

  const STATUS_TEXT = { idle: 'Detenido', loading: 'Cargando…', playing: 'Reproduciendo', paused: 'En pausa', ended: 'Finalizado', error: 'Error' };
  const SHORTCUT_ACTIONS = [
    ['toggle', 'Pausar / reanudar'],
    ['next', 'Siguiente video'],
    ['prev', 'Video anterior'],
    ['add', 'Agregar un enlace'],
    ['save', 'Guardar la lista'],
    ['fullscreen', 'Pantalla completa']
  ];
  const DEFAULT_KEYS = { toggle: 'Space', next: 'ArrowRight', prev: 'ArrowLeft', add: 'Ctrl+O', save: 'Ctrl+S', fullscreen: 'F11' };

  const rows = new Map();
  let seeking = false;
  let recordingKey = null;
  let modalCount = 0;

  const cmd = async (c) => {
    const r = await window.api.cmd(c);
    if (r && r.ok === false && r.error) toast('error', r.error);
    return r;
  };

  // ------------------------------------------------------------------ avisos
  function toast(level, text, ms = 5000) {
    if (S.presentation && level !== 'error') return; // modo presentación: solo errores, y solo aquí (nunca en la pantalla externa)
    const el = h('div', { class: `toast ${level}`, role: level === 'error' ? 'alert' : 'status', text });
    $('#toasts').append(el);
    setTimeout(() => el.remove(), level === 'error' ? Math.max(ms, 7000) : ms);
    while ($('#toasts').children.length > 4) $('#toasts').firstChild.remove();
  }

  // ------------------------------------------------------------------ modales
  function openModal({ title, body, buttons }) {
    const root = $('#modalRoot');
    const back = h('div', { class: 'modal-back' });
    const close = () => { back.remove(); modalCount--; document.removeEventListener('keydown', onKey, true); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    const foot = h('div', { class: 'modal-foot' }, buttons.map((b) =>
      h('button', {
        class: `btn ${b.kind || ''}`, type: 'button', text: b.label,
        onclick: async () => { const keep = b.onClick ? await b.onClick() : false; if (keep !== true) close(); }
      })
    ));
    back.append(h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
      h('h3', { text: title }), h('div', { class: 'modal-body' }, body), foot));
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    root.append(back);
    modalCount++;
    document.addEventListener('keydown', onKey, true);
    const first = $('input, button', back.querySelector('.modal-body')) || $('button', foot);
    if (first) first.focus();
    return close;
  }

  function confirmModal(title, message, okLabel = 'Continuar') {
    return new Promise((resolve) => {
      let done = false;
      const fin = (v) => { if (!done) { done = true; resolve(v); } };
      const close = openModal({
        title, body: h('p', { text: message }),
        buttons: [
          { label: 'Cancelar', onClick: () => fin(false) },
          { label: okLabel, kind: 'primary', onClick: () => fin(true) }
        ]
      });
      // si se cierra con Esc o clic fuera
      const obs = new MutationObserver(() => { if (!document.body.contains($('.modal-back'))) { fin(false); obs.disconnect(); } });
      obs.observe($('#modalRoot'), { childList: true });
      void close;
    });
  }

  // ------------------------------------------------------------------ agregar enlaces
  async function addUrl(as) {
    const input = $('#urlInput');
    const url = input.value.trim();
    if (!url) { toast('error', 'Pega primero un enlace de YouTube.'); input.focus(); return; }
    const btn = $('#addBtn');
    btn.disabled = true; btn.textContent = 'Procesando…';
    try {
      const r = await cmd({ type: 'add-url', url, as });
      if (!r || !r.ok) return;
      if (r.needsChoice === 'both') return askBoth(url);
      if (r.needsChoice === 'playlist') { input.value = ''; return askPlaylist(r.items, r.warning); }
      input.value = '';
      toast('success', r.unavailable ? 'Video agregado (no se pudo leer su título; se mostrará al reproducirlo).' : 'Video agregado a la lista.');
    } finally {
      btn.disabled = false; btn.textContent = 'Agregar';
    }
  }

  function askBoth(url) {
    openModal({
      title: 'El enlace contiene un video y una lista',
      body: h('p', { text: '¿Qué deseas agregar?' }),
      buttons: [
        { label: 'Cancelar' },
        { label: 'Solo este video', onClick: () => { addUrlAs(url, 'video'); } },
        { label: 'Toda la lista', kind: 'primary', onClick: () => { addUrlAs(url, 'playlist'); } }
      ]
    });
  }
  async function addUrlAs(url, as) { $('#urlInput').value = url; await addUrl(as); }

  function askPlaylist(items, warning) {
    if (!items.length) { toast('error', 'La lista no contiene videos disponibles.'); return; }
    const checks = items.map(() => true);
    const counter = h('span', { class: 'muted' });
    const upd = () => { counter.textContent = `${checks.filter(Boolean).length} de ${items.length} seleccionados`; };
    const boxes = items.map((it, i) => h('input', { type: 'checkbox', checked: true, onchange: (e) => { checks[i] = e.target.checked; upd(); } }));
    const list = h('div', { class: 'pick-list' }, items.map((it, i) =>
      h('label', { class: 'pick' }, boxes[i], h('span', { class: 't', title: it.title, text: `${i + 1}. ${it.title}` }), h('span', { class: 'd', text: it.duration ? fmt(it.duration) : '' }))));
    const setAll = (v) => { boxes.forEach((b, i) => { b.checked = v; checks[i] = v; }); upd(); };
    let mode = 'append';
    const radio = (val, label) => h('label', null, h('input', { type: 'radio', name: 'addmode', value: val, checked: val === mode, onchange: () => { mode = val; } }), label);
    const body = h('div', null,
      h('p', { text: `Se encontraron ${items.length} videos. Elige cuáles agregar.` }),
      warning ? h('div', { class: 'warn-text', text: warning }) : null,
      h('div', { class: 'row-between' }, counter,
        h('span', null, h('button', { class: 'btn small', type: 'button', text: 'Todos', onclick: () => setAll(true) }), ' ',
          h('button', { class: 'btn small', type: 'button', text: 'Ninguno', onclick: () => setAll(false) }))),
      list,
      h('div', { class: 'radios' }, radio('append', 'Agregar al final de la cola'), radio('replace', 'Reemplazar la cola actual'))
    );
    upd();
    const submit = async (all) => {
      const chosen = all ? items : items.filter((_, i) => checks[i]);
      if (!chosen.length) { toast('error', 'Selecciona al menos un video.'); return true; }
      if (mode === 'replace' && S.queue.length) {
        const ok = await confirmModal('Reemplazar la cola actual', `Se eliminarán los ${S.queue.length} videos de la cola actual y se detendrá la reproducción. ¿Continuar?`, 'Reemplazar');
        if (!ok) return true;
      }
      const r = await cmd({ type: 'add-items', items: chosen, mode });
      if (r && r.ok) toast('success', `Se agregaron ${r.added} videos.`);
    };
    openModal({
      title: 'Agregar lista de reproducción', body,
      buttons: [
        { label: 'Cancelar' },
        { label: 'Agregar seleccionados', onClick: () => submit(false) },
        { label: 'Agregar todos', kind: 'primary', onClick: () => submit(true) }
      ]
    });
  }

  function saveListModal() {
    if (!S.queue.length) { toast('error', 'La cola está vacía; no hay nada que guardar.'); return; }
    const input = h('input', { type: 'text', placeholder: 'Nombre de la lista', maxlength: '80' });
    input.value = `Lista ${new Date().toLocaleDateString('es-MX')}`;
    const go = async () => {
      const r = await cmd({ type: 'save-playlist', name: input.value });
      if (r && r.ok) { toast('success', 'Lista guardada.'); return false; }
      return true;
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('.modal-foot .primary').click(); } });
    openModal({
      title: 'Guardar lista actual',
      body: h('div', null, h('p', { class: 'muted', text: `${S.queue.length} videos se guardarán para usarlos después.` }), input),
      buttons: [{ label: 'Cancelar' }, { label: 'Guardar', kind: 'primary', onClick: go }]
    });
    input.select();
  }

  function viewSavedModal(pl) {
    const body = h('div', null,
      h('p', { class: 'muted', text: 'Haz clic en un video para cargar la lista y continuar desde él.' }),
      h('div', { class: 'pick-list' }, pl.items.map((it, i) =>
        h('div', { class: 'pick', style: 'cursor:pointer' },
          h('span', { class: 't', title: it.title, text: `${i + 1}. ${it.title}` }),
          h('span', { class: 'd', text: it.duration ? fmt(it.duration) : '' })))));
    const close = openModal({ title: pl.name, body, buttons: [{ label: 'Cerrar' }] });
    $$('.pick', body).forEach((el, i) => el.addEventListener('click', async () => {
      if (S.queue.length && !(await confirmModal('Cargar lista guardada', 'Se reemplazará la cola actual por la lista guardada y se reproducirá el video elegido.', 'Cargar'))) return;
      close();
      cmd({ type: 'load-playlist', id: pl.id, mode: 'replace', startIndex: i });
    }));
  }

  // ------------------------------------------------------------------ cola
  function matches(item) {
    const q = S.search.trim().toLowerCase();
    if (q && !item.title.toLowerCase().includes(q)) return false;
    switch (S.filter) {
      case 'current': return item.id === S.currentId;
      case 'pending': return !item.played && item.id !== S.currentId && !item.error;
      case 'played': return item.played;
      case 'error': return !!item.error;
      default: return true;
    }
  }

  function buildRow(item, index) {
    const li = h('li', {
      class: 'q-item', draggable: 'true', 'data-id': item.id,
      onclick: () => { S.selectedId = item.id; updateMarkers(); },
      ondblclick: () => cmd({ type: 'play-id', id: item.id })
    });
    li.append(
      h('div', { class: 'q-num', text: String(index + 1) }),
      h('img', { class: 'q-thumb', src: item.thumbnail, alt: '', loading: 'lazy', draggable: 'false' }),
      h('div', null,
        h('div', { class: 'q-title', title: item.title, text: item.title }),
        h('div', { class: 'q-meta' }, h('span', { text: item.duration ? fmt(item.duration) : '' }), h('span', { class: 'badges' }))),
      h('div', { class: 'q-actions' },
        h('button', { class: 'icon-btn', type: 'button', title: 'Reproducir ahora', text: '▶', onclick: (e) => { e.stopPropagation(); cmd({ type: 'play-id', id: item.id }); } }),
        h('button', { class: 'icon-btn del', type: 'button', title: 'Quitar de la lista', text: '✕', onclick: (e) => { e.stopPropagation(); cmd({ type: 'remove', id: item.id }); } }))
    );
    li.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', item.id); e.dataTransfer.effectAllowed = 'move'; li.classList.add('dragging'); });
    li.addEventListener('dragend', () => { li.classList.remove('dragging'); $$('.dragover').forEach((x) => x.classList.remove('dragover')); });
    li.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; li.classList.add('dragover'); });
    li.addEventListener('dragleave', () => li.classList.remove('dragover'));
    li.addEventListener('drop', (e) => {
      e.preventDefault(); li.classList.remove('dragover');
      const fromId = e.dataTransfer.getData('text/plain');
      const from = S.queue.findIndex((x) => x.id === fromId);
      const to = S.queue.findIndex((x) => x.id === item.id);
      if (from >= 0 && to >= 0 && from !== to) cmd({ type: 'move', from, to });
    });
    return { li, item };
  }

  function renderQueue() {
    const list = $('#queueList');
    list.replaceChildren();
    rows.clear();
    const frag = document.createDocumentFragment();
    let shown = 0;
    S.queue.forEach((item, i) => {
      if (!matches(item)) return;
      shown++;
      const r = buildRow(item, i);
      rows.set(item.id, r);
      frag.append(r.li);
    });
    list.append(frag);
    $('#queueEmpty').hidden = shown > 0;
    $('#queueEmpty').textContent = S.queue.length ? 'Ningún video coincide con la búsqueda o el filtro.' : 'La lista está vacía. Pega un enlace arriba para empezar.';
    $('#queueCount').textContent = S.queue.length ? (shown === S.queue.length ? `${S.queue.length} videos` : `${shown} de ${S.queue.length}`) : '';
    updateMarkers();
  }

  function updateMarkers() {
    rows.forEach(({ li, item }, id) => {
      li.classList.toggle('current', id === S.currentId);
      li.classList.toggle('next', id === S.nextId && id !== S.currentId);
      li.classList.toggle('selected', id === S.selectedId);
      const b = li.querySelector('.badges');
      b.replaceChildren();
      if (id === S.currentId) {
        const txt = S.status === 'playing' ? '▶ Reproduciendo' : S.status === 'paused' ? '⏸ En pausa' : S.status === 'loading' ? 'Cargando…' : 'Actual';
        b.append(h('span', { class: 'badge cur', text: txt }));
      } else if (id === S.nextId) b.append(h('span', { class: 'badge nxt', text: 'Siguiente' }));
      if (item.played && id !== S.currentId) b.append(h('span', { class: 'badge done', text: 'Reproducido' }));
      if (item.error) b.append(h('span', { class: 'badge err', title: item.error, text: 'Error' }));
    });
  }

  // ------------------------------------------------------------------ centro / estado
  function currentItem() { return S.queue.find((i) => i.id === S.currentId) || null; }

  function renderCenter() {
    const it = currentItem();
    const nxt = S.queue.find((i) => i.id === S.nextId);
    $('#nowTitle').textContent = it ? it.title : 'Ningún video seleccionado';
    $('#nowPos').textContent = it ? `· posición ${S.currentIndex + 1} de ${S.queue.length}` : '';
    $('#nowNext').textContent = nxt ? `Siguiente: ${nxt.title}` : (it ? 'Es el último video de la lista' : '');
    const img = $('#nowThumb');
    if (it) { if (img.getAttribute('src') !== it.thumbnail) img.src = it.thumbnail; img.hidden = false; $('#nowThumbEmpty').hidden = true; }
    else { img.hidden = true; $('#nowThumbEmpty').hidden = false; }
    const err = $('#nowError');
    const msg = S.status === 'error' ? (S.error || (it && it.error)) : null;
    err.hidden = !msg; err.textContent = msg || '';

    const playing = S.wantPlaying && ['playing', 'loading'].includes(S.status);
    const pb = $('#playBtn');
    pb.firstChild.textContent = playing ? '⏸' : '▶';
    pb.querySelector('span').textContent = playing ? 'Pausar' : (S.status === 'paused' ? 'Reanudar' : 'Reproducir');

    $('#autoplayChk').checked = S.autoplay;
    $$('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.repeat === S.repeat));
    $('#volRange').value = S.volume;
    $('#volText').textContent = S.muted ? 'Mute' : `${S.volume}%`;
    $('#muteBtn').textContent = S.muted || S.volume === 0 ? '🔇' : '🔊';
    $('#presentBtn').classList.toggle('active', S.presentation);
    $('#retryBtn').hidden = !(S.status === 'error' || !S.displayOnline);
  }

  function renderStatusbar() {
    const chip = $('#statusChip');
    let text = STATUS_TEXT[S.status] || S.status;
    let cls = 'chip';
    if (S.status === 'playing') cls += ' play';
    else if (S.status === 'loading') cls += ' warn';
    else if (S.status === 'error') cls += ' err';
    if (S.status === 'loading' && !S.displayReady) text = 'Esperando pantalla de reproducción…';
    chip.className = cls; chip.textContent = text;

    const sc = $('#screenChip');
    if (!S.displayOpen) { sc.className = 'chip warn'; sc.textContent = 'Pantalla: sin abrir'; }
    else if (!S.displayReady) { sc.className = 'chip warn'; sc.textContent = 'Pantalla: conectando…'; }
    else { sc.className = 'chip ok'; sc.textContent = `Pantalla: conectada${S.displayFullscreen ? ' · completa' : ''}`; }

    const online = navigator.onLine && S.displayOnline;
    const nc = $('#netChip');
    nc.className = `chip ${online ? 'ok' : 'err'}`;
    nc.textContent = online ? 'En línea' : 'Sin conexión a Internet';
    renderTime();
  }

  function renderTime() {
    if (!seeking) {
      $('#timeNow').textContent = fmt(S.position);
      $('#seekRange').value = S.duration > 0 ? Math.round((S.position / S.duration) * 1000) : 0;
    }
    $('#timeTotal').textContent = fmt(S.duration);
  }

  // ------------------------------------------------------------------ panel derecho
  function renderDisplays() {
    const sel = $('#displaySelect');
    const cur = S.library.settings.displayId;
    sel.replaceChildren(h('option', { value: '', text: 'Automática (pantalla externa si existe)' }),
      S.displays.map((d) => h('option', { value: String(d.id), text: d.label })));
    sel.value = cur == null ? '' : String(cur);
    if (sel.value !== (cur == null ? '' : String(cur))) sel.value = '';
  }

  function renderLibrary() {
    const st = S.library.settings;
    $('#fsOnOpenChk').checked = !!st.fullscreen;
    $('#resumeChk').checked = !!st.resumeOnStart;
    $('#apiKeyHint').textContent = st.hasApiKey ? 'Hay una clave guardada (no se muestra por seguridad).' : 'Sin clave: las listas largas se leen de forma limitada.';
    renderDisplays();

    const sl = $('#savedList');
    sl.replaceChildren();
    if (!S.library.playlists.length) sl.append(h('li', { class: 'muted', text: 'Aún no hay listas guardadas.' }));
    for (const pl of S.library.playlists) {
      sl.append(h('li', null,
        h('div', { class: 'li-title', text: pl.name }),
        h('div', { class: 'muted small', text: `${pl.count} videos · ${new Date(pl.savedAt).toLocaleString('es-MX')}` }),
        h('div', { class: 'li-actions' },
          h('button', { class: 'btn small', type: 'button', text: 'Ver videos', onclick: () => viewSavedModal(pl) }),
          h('button', { class: 'btn small', type: 'button', text: 'Agregar al final', onclick: () => cmd({ type: 'load-playlist', id: pl.id, mode: 'append' }).then((r) => r && r.ok && toast('success', 'Lista agregada al final.')) }),
          h('button', { class: 'btn small', type: 'button', text: 'Reemplazar cola', onclick: async () => {
            if (S.queue.length && !(await confirmModal('Reemplazar la cola actual', `Se eliminarán los ${S.queue.length} videos actuales.`, 'Reemplazar'))) return;
            cmd({ type: 'load-playlist', id: pl.id, mode: 'replace' });
          } }),
          h('button', { class: 'btn small danger', type: 'button', text: 'Eliminar', onclick: async () => {
            if (await confirmModal('Eliminar lista guardada', `¿Eliminar «${pl.name}»?`, 'Eliminar')) cmd({ type: 'delete-playlist', id: pl.id });
          } }))));
    }

    const hl = $('#historyList');
    hl.replaceChildren();
    if (!S.library.history.length) hl.append(h('li', { class: 'muted', text: 'El historial está vacío.' }));
    for (const x of S.library.history.slice(0, 200)) {
      hl.append(h('li', { class: 'hist-item', title: 'Clic para volver a reproducir', onclick: () => cmd({ type: 'history-play', videoId: x.videoId }) },
        h('div', { class: 'li-title', text: x.title }),
        h('div', { class: 'muted small', text: `${new Date(x.at).toLocaleString('es-MX')}${x.index ? ` · posición ${x.index}` : ''}` })));
    }
    renderKeys();
  }

  function renderKeys() {
    const keys = { ...DEFAULT_KEYS, ...(S.library.settings.shortcuts || {}) };
    const t = $('#keysTable');
    t.replaceChildren();
    for (const [id, label] of SHORTCUT_ACTIONS) {
      t.append(h('tr', null, h('td', { text: label }), h('td', null,
        h('button', {
          class: `btn small${recordingKey === id ? ' rec' : ''}`, type: 'button',
          text: recordingKey === id ? 'Pulsa una tecla…' : keys[id],
          onclick: () => { recordingKey = recordingKey === id ? null : id; renderKeys(); }
        }))));
    }
  }

  // ------------------------------------------------------------------ atajos
  function comboFromEvent(e) {
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
    let k = e.key;
    if (k === ' ') k = 'Space';
    if (k.length === 1) k = k.toUpperCase();
    const parts = [];
    if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    parts.push(k);
    return parts.join('+');
  }

  function isEditable(t) {
    if (!t || !t.tagName) return false;
    const tag = t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
  }

  const ACTIONS = {
    toggle: () => cmd({ type: 'toggle' }),
    next: () => cmd({ type: 'next' }),
    prev: () => cmd({ type: 'prev' }),
    add: () => { const i = $('#urlInput'); i.focus(); i.select(); },
    save: () => saveListModal(),
    fullscreen: () => cmd({ type: 'toggle-fullscreen-context' })
  };

  document.addEventListener('keydown', (e) => {
    const combo = comboFromEvent(e);
    if (!combo) return;

    if (recordingKey) {
      e.preventDefault();
      if (combo === 'Escape') { recordingKey = null; renderKeys(); return; }
      const shortcuts = { ...(S.library.settings.shortcuts || {}), [recordingKey]: combo };
      recordingKey = null;
      S.library.settings.shortcuts = shortcuts;
      renderKeys();
      cmd({ type: 'set-settings', shortcuts });
      return;
    }
    if (modalCount > 0) return;

    const keys = { ...DEFAULT_KEYS, ...(S.library.settings.shortcuts || {}) };
    const action = Object.keys(keys).find((a) => keys[a] === combo);
    if (!action) return;
    const plain = !/^(Ctrl|Alt)\+/.test(combo) && !/^F\d+$/.test(combo);
    if (plain && isEditable(e.target)) return; // no interferir con la escritura
    e.preventDefault();
    ACTIONS[action]();
  });

  // quitar el foco de los botones tras pulsarlos (evita que Espacio los vuelva a activar)
  document.addEventListener('click', (e) => { const b = e.target.closest && e.target.closest('button'); if (b && !b.closest('.modal')) b.blur(); });

  // ------------------------------------------------------------------ eventos de la interfaz
  function bind() {
    $('#addForm').addEventListener('submit', (e) => { e.preventDefault(); addUrl(); });
    $('#presentBtn').addEventListener('click', () => cmd({ type: 'presentation', on: !S.presentation }));

    $('#searchInput').addEventListener('input', (e) => { S.search = e.target.value; renderQueue(); });
    $('#filterSelect').addEventListener('change', (e) => { S.filter = e.target.value; renderQueue(); });
    $('#saveListBtn').addEventListener('click', saveListModal);
    $('#clearBtn').addEventListener('click', async () => {
      if (!S.queue.length) return;
      if (await confirmModal('Vaciar la lista', `Se eliminarán los ${S.queue.length} videos de la cola y se detendrá la reproducción.`, 'Vaciar')) cmd({ type: 'clear' });
    });

    $('#playBtn').addEventListener('click', () => cmd({ type: 'toggle' }));
    $('#prevBtn').addEventListener('click', () => cmd({ type: 'prev' }));
    $('#nextBtn').addEventListener('click', () => cmd({ type: 'next' }));
    $('#backBtn').addEventListener('click', () => cmd({ type: 'seek-by', seconds: -10 }));
    $('#fwdBtn').addEventListener('click', () => cmd({ type: 'seek-by', seconds: 10 }));
    $('#restartBtn').addEventListener('click', () => cmd({ type: 'restart' }));
    $('#stopBtn').addEventListener('click', () => cmd({ type: 'stop' }));
    $('#retryBtn').addEventListener('click', () => cmd({ type: 'retry' }));

    $('#autoplayChk').addEventListener('change', (e) => cmd({ type: 'autoplay', value: e.target.checked }));
    $$('.seg-btn').forEach((b) => b.addEventListener('click', () => cmd({ type: 'repeat', mode: b.dataset.repeat })));

    $('#volRange').addEventListener('input', (e) => cmd({ type: 'volume', value: Number(e.target.value) }));
    $('#volDownBtn').addEventListener('click', () => cmd({ type: 'volume', value: S.volume - 10 }));
    $('#volUpBtn').addEventListener('click', () => cmd({ type: 'volume', value: S.volume + 10 }));
    $('#muteBtn').addEventListener('click', () => cmd({ type: 'mute', muted: !S.muted }));

    const seek = $('#seekRange');
    seek.addEventListener('input', () => { seeking = true; $('#timeNow').textContent = fmt((seek.value / 1000) * S.duration); });
    seek.addEventListener('change', () => { seeking = false; if (S.duration > 0) cmd({ type: 'seek-to', seconds: (seek.value / 1000) * S.duration }); });

    $$('.tab').forEach((t) => t.addEventListener('click', () => {
      $$('.tab').forEach((x) => x.classList.toggle('active', x === t));
      $$('.tabpane').forEach((p) => { p.hidden = p.dataset.pane !== t.dataset.tab; });
    }));

    $('#displaySelect').addEventListener('change', (e) => cmd({ type: 'display-select', id: e.target.value === '' ? null : Number(e.target.value) }));
    $('#detectBtn').addEventListener('click', async () => {
      const init = await window.api.init();
      if (init) { S.displays = init.displays; renderDisplays(); toast('info', `Se detectaron ${S.displays.length} pantalla(s).`); }
    });
    $('#dispOpenBtn').addEventListener('click', () => cmd({ type: 'display-open' }));
    $('#dispCloseBtn').addEventListener('click', () => cmd({ type: 'display-close' }));
    $('#dispReconnectBtn').addEventListener('click', () => cmd({ type: 'display-reconnect' }));
    $('#dispFsBtn').addEventListener('click', () => cmd({ type: 'display-fullscreen' }));
    $('#fsOnOpenChk').addEventListener('change', (e) => cmd({ type: 'set-settings', fullscreen: e.target.checked }));
    $('#resumeChk').addEventListener('change', (e) => cmd({ type: 'set-settings', resumeOnStart: e.target.checked }));
    $('#apiKeyBtn').addEventListener('click', async () => {
      const r = await cmd({ type: 'set-settings', apiKey: $('#apiKeyInput').value });
      if (r && r.ok) { $('#apiKeyInput').value = ''; toast('success', 'Clave guardada.'); }
    });
    $('#clearHistBtn').addEventListener('click', () => cmd({ type: 'clear-history' }));
    $('#keysResetBtn').addEventListener('click', () => { S.library.settings.shortcuts = { ...DEFAULT_KEYS }; renderKeys(); cmd({ type: 'set-settings', shortcuts: DEFAULT_KEYS }); });

    window.addEventListener('online', renderStatusbar);
    window.addEventListener('offline', () => { renderStatusbar(); toast('error', 'Sin conexión a Internet. Cuando vuelva, pulsa «Reintentar».'); });
  }

  // ------------------------------------------------------------------ arranque
  function applyState(s) {
    const qChanged = Array.isArray(s.queue);
    Object.assign(S, s);
    if (qChanged) renderQueue(); else updateMarkers();
    renderCenter();
    renderStatusbar();
  }

  async function start() {
    bind();
    window.api.on('state', applyState);
    window.api.on('time', (t) => { S.position = t.position; S.duration = t.duration; renderTime(); });
    window.api.on('notice', (n) => toast(n.level, n.text));
    window.api.on('displays', (d) => { S.displays = d; renderDisplays(); });
    window.api.on('library', (l) => { S.library = l; renderLibrary(); });
    const init = await window.api.init();
    if (!init) return;
    S.displays = init.displays;
    S.library = init.library;
    applyState(init.state);
    renderLibrary();
  }
  start();
})();
