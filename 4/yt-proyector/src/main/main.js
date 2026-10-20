'use strict';
const path = require('path');
const http = require('http');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, screen, Menu } = require('electron');
const { PlaybackController } = require('./playback');
const { Store } = require('./store');
const yt = require('./youtube');
const { parseYouTubeUrl } = require('../shared/urlparser');

const SRC = path.join(__dirname, '..');
let controlWin = null;
let displayWin = null;
let store = null;
let controller = null;
let server = null;
let serverPort = 0;
let lastQueueRev = -1;
let persistTimer = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
}
app.on('second-instance', () => {
  if (controlWin) { if (controlWin.isMinimized()) controlWin.restore(); controlWin.focus(); }
});

// ---------------------------------------------------------------------------
// Servidor local para la pantalla de reproducción.
// YouTube exige un origen http(s) real para el reproductor incrustado; con
// file:// aparece el error 153. Solo sirve 3 archivos y solo en 127.0.0.1.
// ---------------------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const ALLOWED = new Set(['/index.html', '/display.js', '/display.css']);
const DISPLAY_CSP = [
  "default-src 'self'",
  "script-src 'self' https://*.youtube.com https://*.ytimg.com https://*.google.com https://*.gstatic.com",
  "frame-src https://*.youtube.com https://*.youtube-nocookie.com",
  "img-src 'self' data: https:",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' https:"
].join('; ');

function startServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let p = '/';
      try { p = new URL(req.url, 'http://x').pathname; } catch { /* ignore */ }
      if (p === '/') p = '/index.html';
      if (!ALLOWED.has(p)) { res.writeHead(404); res.end(); return; }
      fs.readFile(path.join(SRC, 'display', p.slice(1)), (err, buf) => {
        if (err) { res.writeHead(500); res.end(); return; }
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(p)] || 'application/octet-stream',
          'Content-Security-Policy': DISPLAY_CSP,
          'Referrer-Policy': 'strict-origin-when-cross-origin',
          'Cache-Control': 'no-store'
        });
        res.end(buf);
      });
    });
    server.listen(0, '127.0.0.1', () => { serverPort = server.address().port; resolve(); });
  });
}

// ---------------------------------------------------------------------------
// Comunicación con el panel de control
// ---------------------------------------------------------------------------
function sendToControl(channel, payload) {
  if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send(channel, payload);
}

function fullState(snap) {
  return {
    ...snap,
    displayOpen: !!displayWin,
    displayFullscreen: displayWin ? displayWin.isFullScreen() : false,
    presentation: !!store.data.settings.presentation
  };
}

function broadcastState(snap) {
  const out = fullState(snap || controller.snapshot());
  if (out.queueRev === lastQueueRev) delete out.queue; else lastQueueRev = out.queueRev;
  sendToControl('state', out);
  schedulePersist();
}

function persistNow() {
  store.data.session = controller.toPersist();
  store.save();
}
function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistNow, 1000);
}

function libraryPayload() {
  const s = store.data.settings;
  return {
    playlists: store.data.playlists.map((p) => ({
      id: p.id, name: p.name, savedAt: p.savedAt, count: p.items.length,
      items: p.items.map((i) => ({ videoId: i.videoId, title: i.title, duration: i.duration }))
    })),
    history: store.data.history,
    settings: {
      displayId: s.displayId, fullscreen: s.fullscreen, resumeOnStart: s.resumeOnStart,
      shortcuts: s.shortcuts, hasApiKey: !!s.apiKey
    }
  };
}
const sendLibrary = () => sendToControl('library', libraryPayload());

function listDisplays() {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    primary: d.id === primary,
    label: `Pantalla ${i + 1}${d.id === primary ? ' (principal)' : ''}${d.label ? ' – ' + d.label : ''} · ${d.size.width}×${d.size.height}`
  }));
}
const sendDisplays = () => sendToControl('displays', listDisplays());

// ---------------------------------------------------------------------------
// Ventana de proyección
// ---------------------------------------------------------------------------
function targetDisplay() {
  const all = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const id = store.data.settings.displayId;
  return all.find((d) => d.id === id) || all.find((d) => d.id !== primary.id) || primary;
}

function centeredBounds(d, w = 1280, h = 720) {
  const width = Math.min(w, d.workArea.width);
  const height = Math.min(h, d.workArea.height);
  return {
    x: d.workArea.x + Math.round((d.workArea.width - width) / 2),
    y: d.workArea.y + Math.round((d.workArea.height - height) / 2),
    width, height
  };
}

function openDisplay({ fullscreen } = {}) {
  if (displayWin) {
    displayWin.show();
    displayWin.focus();
    if (fullscreen === true && !displayWin.isFullScreen()) displayWin.setFullScreen(true);
    return;
  }
  const multi = screen.getAllDisplays().length > 1;
  const wantFs = fullscreen !== undefined ? fullscreen : (multi && store.data.settings.fullscreen);
  const d = targetDisplay();

  displayWin = new BrowserWindow({
    ...centeredBounds(d),
    title: 'Pantalla de reproducción',
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-display.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });
  const win = displayWin;
  win.setMenuBarVisibility(false);
  win.once('ready-to-show', () => {
    win.show();
    if (wantFs) win.setFullScreen(true);
    broadcastState();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${serverPort}/`)) e.preventDefault();
  });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    else if (input.key === 'Escape' && win.isFullScreen()) { win.setFullScreen(false); e.preventDefault(); }
  });
  win.on('enter-full-screen', () => broadcastState());
  win.on('leave-full-screen', () => broadcastState());
  win.on('closed', () => {
    displayWin = null;
    controller.displayClosed();
    broadcastState();
  });
  win.loadURL(`http://127.0.0.1:${serverPort}/index.html`);
  broadcastState();
}

function closeDisplay() {
  if (displayWin) displayWin.close();
}

function moveDisplayToTarget() {
  if (!displayWin) return;
  const win = displayWin;
  const d = targetDisplay();
  const multi = screen.getAllDisplays().length > 1;
  const wasFs = win.isFullScreen();
  const apply = () => {
    if (!win || win.isDestroyed()) return;
    win.setBounds(centeredBounds(d));
    if (wasFs || (multi && store.data.settings.fullscreen)) setTimeout(() => { if (!win.isDestroyed()) win.setFullScreen(true); }, 250);
  };
  if (wasFs) { win.setFullScreen(false); setTimeout(apply, 350); } else apply();
}

function reconnectDisplay() {
  if (!displayWin) { openDisplay(); return; }
  controller.displayClosed();
  moveDisplayToTarget();
  displayWin.webContents.reload();
}

function toggleFullscreen() {
  if (displayWin) displayWin.setFullScreen(!displayWin.isFullScreen());
  else openDisplay({ fullscreen: true });
}

function setPresentation(on) {
  store.data.settings.presentation = !!on;
  if (on) openDisplay({ fullscreen: true });
  store.save();
  broadcastState();
}

function onDisplaysChanged(kind, removed) {
  sendDisplays();
  if (kind === 'added') sendToControl('notice', { level: 'info', text: 'Se detectó una nueva pantalla. Selecciónala en la pestaña «Pantalla».' });
  if (kind === 'removed' && displayWin) {
    setTimeout(() => {
      if (!displayWin) return;
      const ids = screen.getAllDisplays().map((d) => d.id);
      const wanted = store.data.settings.displayId;
      if (wanted && !ids.includes(wanted)) {
        sendToControl('notice', { level: 'error', text: 'Se desconectó la pantalla de destino. La ventana de reproducción se movió a la pantalla disponible.' });
      }
      const center = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
      const c = center(displayWin.getBounds());
      const visible = screen.getAllDisplays().some((d) => c.x >= d.bounds.x && c.x < d.bounds.x + d.bounds.width && c.y >= d.bounds.y && c.y < d.bounds.y + d.bounds.height);
      if (!visible || (removed && removed.id === wanted)) {
        const win = displayWin;
        const fix = () => { if (!win.isDestroyed()) win.setBounds(centeredBounds(screen.getPrimaryDisplay())); };
        if (win.isFullScreen()) { win.setFullScreen(false); setTimeout(fix, 350); } else fix();
      }
      broadcastState();
    }, 600);
  }
}

// ---------------------------------------------------------------------------
// Comandos del panel de control
// ---------------------------------------------------------------------------
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

async function handleCommand(cmd) {
  if (!cmd || typeof cmd.type !== 'string') return { ok: false, error: 'Comando no válido.' };
  const c = controller;
  switch (cmd.type) {
    case 'play': c.play(); break;
    case 'pause': c.pause(); break;
    case 'toggle': c.toggle(); break;
    case 'next': c.next(); break;
    case 'prev': c.prev(); break;
    case 'restart': c.restart(); break;
    case 'retry': c.retry(); break;
    case 'stop': c.stop(); break;
    case 'seek-to': if (num(cmd.seconds) !== null) c.seekTo(cmd.seconds); break;
    case 'seek-by': if (num(cmd.seconds) !== null) c.seekBy(cmd.seconds); break;
    case 'play-id': c.playId(String(cmd.id)); break;
    case 'remove': c.remove(String(cmd.id)); break;
    case 'move': c.move(cmd.from, cmd.to); break;
    case 'clear': c.clear(); break;
    case 'volume': if (num(cmd.value) !== null) c.setVolume(cmd.value); break;
    case 'mute': c.setMuted(!!cmd.muted); break;
    case 'repeat': c.setRepeat(cmd.mode); break;
    case 'autoplay': c.setAutoplay(!!cmd.value); break;

    case 'display-open': openDisplay(); break;
    case 'display-close': closeDisplay(); break;
    case 'display-reconnect': reconnectDisplay(); break;
    case 'display-fullscreen': toggleFullscreen(); break;
    case 'display-select': {
      const id = cmd.id === null || cmd.id === '' ? null : Number(cmd.id);
      store.data.settings.displayId = Number.isFinite(id) ? id : null;
      store.save();
      moveDisplayToTarget();
      sendLibrary();
      break;
    }
    case 'toggle-fullscreen-context':
      if (displayWin) displayWin.setFullScreen(!displayWin.isFullScreen());
      else if (controlWin) controlWin.setFullScreen(!controlWin.isFullScreen());
      break;
    case 'presentation': setPresentation(!!cmd.on); break;

    case 'add-url': {
      const p = parseYouTubeUrl(cmd.url);
      if (!p.ok) return p;
      const as = cmd.as || (p.kind === 'both' ? null : p.kind);
      if (!as) return { ok: true, needsChoice: 'both', videoId: p.videoId, playlistId: p.playlistId };
      if (as === 'video') {
        if (!p.videoId) return { ok: false, error: 'El enlace no contiene un video.' };
        const m = await yt.getVideoMeta(p.videoId);
        c.addItems([m], 'append');
        return { ok: true, added: 1, unavailable: !!m.unavailable };
      }
      if (!p.playlistId) return { ok: false, error: 'El enlace no contiene una lista de reproducción.' };
      const res = await yt.getPlaylist(p.playlistId, store.data.settings.apiKey);
      return { ok: true, needsChoice: 'playlist', items: res.items, warning: res.warning, source: res.source };
    }
    case 'add-items': {
      const n = c.addItems(cmd.items, cmd.mode === 'replace' ? 'replace' : 'append');
      return { ok: true, added: n };
    }

    case 'save-playlist': {
      const name = String(cmd.name || '').trim().slice(0, 80);
      if (!name) return { ok: false, error: 'Escribe un nombre para la lista.' };
      if (!c.queue.length) return { ok: false, error: 'La cola está vacía; no hay nada que guardar.' };
      store.data.playlists.unshift({
        id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        name, savedAt: Date.now(),
        items: c.queue.map((i) => ({ videoId: i.videoId, title: i.title, duration: i.duration }))
      });
      store.save(); sendLibrary();
      return { ok: true };
    }
    case 'load-playlist': {
      const pl = store.data.playlists.find((p) => p.id === cmd.id);
      if (!pl) return { ok: false, error: 'No se encontró la lista guardada.' };
      const mode = cmd.mode === 'append' ? 'append' : 'replace';
      const base = mode === 'append' ? c.queue.length : 0;
      c.addItems(pl.items, mode);
      if (Number.isInteger(cmd.startIndex) && cmd.startIndex >= 0 && cmd.startIndex < pl.items.length) c.playIndex(base + cmd.startIndex);
      return { ok: true };
    }
    case 'delete-playlist':
      store.data.playlists = store.data.playlists.filter((p) => p.id !== cmd.id);
      store.save(); sendLibrary();
      break;

    case 'history-play': {
      const h = store.data.history.find((x) => x.videoId === cmd.videoId);
      if (!h) break;
      let idx = c.queue.findIndex((i) => i.videoId === h.videoId);
      if (idx < 0) { c.addItems([{ videoId: h.videoId, title: h.title }], 'append'); idx = c.queue.length - 1; }
      c.playIndex(idx);
      break;
    }
    case 'clear-history':
      store.data.history = [];
      store.save(); sendLibrary();
      break;

    case 'set-settings': {
      const s = store.data.settings;
      if (typeof cmd.fullscreen === 'boolean') s.fullscreen = cmd.fullscreen;
      if (typeof cmd.resumeOnStart === 'boolean') s.resumeOnStart = cmd.resumeOnStart;
      if (cmd.shortcuts && typeof cmd.shortcuts === 'object') {
        for (const k of Object.keys(s.shortcuts)) {
          if (typeof cmd.shortcuts[k] === 'string' && cmd.shortcuts[k].length <= 40) s.shortcuts[k] = cmd.shortcuts[k];
        }
      }
      if (typeof cmd.apiKey === 'string') s.apiKey = cmd.apiKey.trim().slice(0, 100);
      store.save(); sendLibrary();
      break;
    }
    default:
      return { ok: false, error: 'Comando desconocido.' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Ventana de control
// ---------------------------------------------------------------------------
function createControlWindow() {
  controlWin = new BrowserWindow({
    width: 1360, height: 820, minWidth: 980, minHeight: 640,
    title: 'YT Proyector – Panel de control',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-control.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });
  controlWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  controlWin.webContents.on('will-navigate', (e) => e.preventDefault());
  controlWin.loadFile(path.join(SRC, 'control', 'index.html'));
  controlWin.on('closed', () => { controlWin = null; app.quit(); });
}

const DISPLAY_EVENTS = new Set(['ready', 'state', 'time', 'meta', 'error', 'online']);

app.whenReady().then(async () => {
  if (!process.env.YTP_DEBUG) Menu.setApplicationMenu(null);
  store = new Store(path.join(app.getPath('userData'), 'data.json'));
  controller = new PlaybackController();
  controller.restore(store.data.session);

  controller.on('state', broadcastState);
  controller.on('time', (t) => sendToControl('time', t));
  controller.on('notice', (n) => sendToControl('notice', n));
  controller.on('display-command', (cmd) => {
    if (displayWin && !displayWin.isDestroyed()) displayWin.webContents.send('display-command', cmd);
  });
  controller.on('history', ({ item, index }) => {
    const h = store.data.history;
    if (h[0] && h[0].videoId === item.videoId && Date.now() - h[0].at < 5000) return;
    h.unshift({ videoId: item.videoId, title: item.title, at: Date.now(), index: index + 1 });
    if (h.length > 500) h.length = 500;
    store.save(); sendLibrary();
  });

  ipcMain.handle('init', (e) => {
    if (!controlWin || e.sender !== controlWin.webContents) return null;
    const snap = fullState(controller.snapshot());
    lastQueueRev = snap.queueRev;
    return { state: snap, displays: listDisplays(), library: libraryPayload() };
  });
  ipcMain.handle('cmd', async (e, cmd) => {
    if (!controlWin || e.sender !== controlWin.webContents) return { ok: false, error: 'Origen no autorizado.' };
    try { return await handleCommand(cmd); } catch (err) { return { ok: false, error: err.message || 'Error inesperado.' }; }
  });
  ipcMain.on('display-event', (e, ev) => {
    if (!displayWin || e.sender !== displayWin.webContents) return;
    if (!ev || !DISPLAY_EVENTS.has(ev.type)) return;
    controller.onDisplayEvent({
      type: ev.type,
      videoId: typeof ev.videoId === 'string' ? ev.videoId : undefined,
      state: Number.isFinite(ev.state) ? ev.state : undefined,
      position: Number.isFinite(ev.position) ? ev.position : undefined,
      duration: Number.isFinite(ev.duration) ? ev.duration : undefined,
      code: Number.isFinite(ev.code) ? ev.code : undefined,
      title: typeof ev.title === 'string' ? ev.title.slice(0, 300) : undefined,
      online: typeof ev.online === 'boolean' ? ev.online : undefined
    });
  });

  screen.on('display-added', () => onDisplaysChanged('added'));
  screen.on('display-removed', (_e, d) => onDisplaysChanged('removed', d));
  screen.on('display-metrics-changed', () => sendDisplays());

  await startServer();
  createControlWindow();

  if (store.data.settings.resumeOnStart && controller.currentIndex >= 0) {
    openDisplay();
    controller.resume();
  } else if (store.data.settings.presentation) {
    openDisplay({ fullscreen: true });
  }
  setInterval(persistNow, 5000);
});

app.on('before-quit', () => { if (store && controller) { persistNow(); store.flush(); } });
app.on('window-all-closed', () => { if (server) server.close(); app.quit(); });
