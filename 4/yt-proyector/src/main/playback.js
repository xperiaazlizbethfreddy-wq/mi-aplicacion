'use strict';
/**
 * Estado centralizado de reproducción.
 *
 * Es la ÚNICA fuente de verdad: el panel de control envía órdenes aquí y la
 * ventana de proyección solo ejecuta los comandos que este controlador emite
 * ("display-command") y reporta eventos del reproductor ("onDisplayEvent").
 * No depende de Electron, por lo que se puede probar con node --test.
 */

const EventEmitter = require('events');
const { VIDEO_ID } = require('../shared/urlparser');

let seq = 0;
const uid = () => `${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

const NO_EMBED = 'El video es privado, tiene restricción de edad o su propietario no permite reproducirlo fuera de YouTube.';
const ERRORS = {
  2: 'El enlace del video no es válido.',
  5: 'El reproductor de YouTube no pudo reproducir este video.',
  100: 'El video no existe, es privado o fue eliminado.',
  101: NO_EMBED,
  150: NO_EMBED,
  152: NO_EMBED,
  153: 'YouTube rechazó la reproducción incrustada (falta de identificación de la aplicación).'
};

class PlaybackController extends EventEmitter {
  constructor({ skipDelayMs = 2500 } = {}) {
    super();
    this.skipDelayMs = skipDelayMs;
    this.queue = [];
    this.queueRev = 0;
    this.currentId = null;
    this.loadedId = null;
    this.status = 'idle'; // idle | loading | playing | paused | ended | error
    this.wantPlaying = false;
    this.position = 0;
    this.duration = 0;
    this.volume = 80;
    this.muted = false;
    this.repeat = 'off'; // off | one | all
    this.autoplay = true;
    this.displayReady = false;
    this.displayOnline = true;
    this.error = null;
    this._skipTimer = null;
    this._errStreak = 0;
  }

  // ---------- consultas ----------
  get currentIndex() {
    return this.queue.findIndex((i) => i.id === this.currentId);
  }
  get current() {
    return this.queue[this.currentIndex] || null;
  }
  get nextIndex() {
    const len = this.queue.length;
    const i = this.currentIndex;
    if (!len) return -1;
    if (i < 0) return 0;
    if (i + 1 < len) return i + 1;
    if (this.repeat === 'all') return 0;
    return -1;
  }

  snapshot() {
    const n = this.nextIndex;
    return {
      queue: this.queue,
      queueRev: this.queueRev,
      currentId: this.currentId,
      currentIndex: this.currentIndex,
      nextId: n >= 0 && this.queue[n] ? this.queue[n].id : null,
      status: this.status,
      wantPlaying: this.wantPlaying,
      error: this.error,
      volume: this.volume,
      muted: this.muted,
      repeat: this.repeat,
      autoplay: this.autoplay,
      position: this.position,
      duration: this.duration,
      displayReady: this.displayReady,
      displayOnline: this.displayOnline
    };
  }

  toPersist() {
    return {
      queue: this.queue.map((i) => ({
        id: i.id, videoId: i.videoId, title: i.title, duration: i.duration, played: i.played
      })),
      currentId: this.currentId,
      position: Math.floor(this.position || 0),
      volume: this.volume,
      muted: this.muted,
      repeat: this.repeat,
      autoplay: this.autoplay
    };
  }

  restore(data) {
    if (!data || typeof data !== 'object') return;
    const items = Array.isArray(data.queue) ? data.queue : [];
    this.queue = [];
    for (const i of items) {
      if (!i || !VIDEO_ID.test(i.videoId)) continue;
      this.queue.push(this._makeItem(i, typeof i.id === 'string' ? i.id : undefined, !!i.played));
    }
    this.queueRev++;
    this.currentId = this.queue.some((i) => i.id === data.currentId) ? data.currentId : (this.queue[0] ? this.queue[0].id : null);
    this.position = Number.isFinite(data.position) ? Math.max(0, data.position) : 0;
    if (Number.isFinite(data.volume)) this.volume = clamp(Math.round(data.volume), 0, 100);
    this.muted = !!data.muted;
    if (['off', 'one', 'all'].includes(data.repeat)) this.repeat = data.repeat;
    if (typeof data.autoplay === 'boolean') this.autoplay = data.autoplay;
    this.status = 'idle';
    this.loadedId = null;
    this.wantPlaying = false;
  }

  // ---------- utilidades internas ----------
  _makeItem(i, id, played = false) {
    return {
      id: id || uid(),
      videoId: i.videoId,
      title: String(i.title || `Video ${i.videoId}`).slice(0, 300),
      thumbnail: `https://i.ytimg.com/vi/${i.videoId}/mqdefault.jpg`,
      duration: Number.isFinite(i.duration) ? Math.max(0, Math.floor(i.duration)) : 0,
      played,
      error: null
    };
  }
  _touchQueue() { this.queueRev++; }
  _update() { this.emit('state', this.snapshot()); }
  _cmd(c) { this.emit('display-command', c); }
  _notice(level, text) { this.emit('notice', { level, text }); }
  _clearSkip() {
    if (this._skipTimer) { clearTimeout(this._skipTimer); this._skipTimer = null; }
  }

  _load(index, { startSeconds = 0, autoplay = true } = {}) {
    const item = this.queue[index];
    if (!item) return false;
    this._clearSkip();
    this.currentId = item.id;
    this.loadedId = item.id;
    this.position = startSeconds;
    this.duration = item.duration || 0;
    this.status = autoplay ? 'loading' : 'paused';
    this.wantPlaying = autoplay;
    this.error = null;
    if (item.error) { item.error = null; this._touchQueue(); }
    if (this.displayReady) {
      this._cmd({ type: 'load', videoId: item.videoId, startSeconds, autoplay, volume: this.volume, muted: this.muted });
    }
    if (autoplay) this.emit('history', { item: { ...item }, index });
    this._update();
    return true;
  }

  // ---------- cola ----------
  addItems(items, mode = 'append') {
    const clean = (Array.isArray(items) ? items : [])
      .filter((i) => i && VIDEO_ID.test(i.videoId))
      .map((i) => this._makeItem(i));
    if (mode === 'replace') this._resetQueue();
    for (const it of clean) this.queue.push(it);
    if (!this.currentId && this.queue.length) this.currentId = this.queue[0].id;
    this._touchQueue();
    this._update();
    return clean.length;
  }

  _resetQueue() {
    this._clearSkip();
    if (this.loadedId) this._cmd({ type: 'stop' });
    this.queue = [];
    this.currentId = null;
    this.loadedId = null;
    this.status = 'idle';
    this.wantPlaying = false;
    this.position = 0;
    this.duration = 0;
    this.error = null;
  }

  clear() {
    this._resetQueue();
    this._touchQueue();
    this._update();
  }

  remove(id) {
    const idx = this.queue.findIndex((i) => i.id === id);
    if (idx < 0) return false;
    const wasCurrent = id === this.currentId;
    const wasLoaded = id === this.loadedId;
    const wasActive = wasLoaded && this.wantPlaying;
    this.queue.splice(idx, 1);
    this._touchQueue();
    if (wasCurrent) {
      this._clearSkip();
      if (wasLoaded) this._cmd({ type: 'stop' });
      const keep = this.queue[idx] || this.queue[idx - 1] || null;
      this.currentId = keep ? keep.id : null;
      this.loadedId = null;
      this.position = 0;
      this.duration = 0;
      this.status = 'idle';
      this.wantPlaying = false;
      this.error = null;
      if (wasActive && this.queue[idx]) { this._load(idx); return true; }
    }
    this._update();
    return true;
  }

  move(from, to) {
    const n = this.queue.length;
    if (!Number.isInteger(from) || !Number.isInteger(to)) return false;
    if (from < 0 || from >= n || to < 0 || to >= n || from === to) return false;
    const [item] = this.queue.splice(from, 1);
    this.queue.splice(to, 0, item);
    this._touchQueue();
    this._update();
    return true;
  }

  // ---------- reproducción ----------
  playIndex(i) { return this._load(i, { autoplay: true }); }
  playId(id) { return this._load(this.queue.findIndex((x) => x.id === id), { autoplay: true }); }
  resume() { // recuperación de sesión
    const i = this.currentIndex;
    if (i < 0) return false;
    return this._load(i, { startSeconds: this.position, autoplay: true });
  }
  retry() {
    const i = this.currentIndex;
    if (i < 0) return false;
    this._errStreak = 0;
    return this._load(i, { startSeconds: this.status === 'error' ? 0 : this.position, autoplay: true });
  }

  play() {
    if (!this.queue.length) { this._notice('info', 'La lista está vacía. Agrega un enlace de YouTube.'); return; }
    if (this.currentIndex < 0) { this._load(0); return; }
    if (!this.loadedId || this.status === 'ended' || this.status === 'error') {
      this._load(this.currentIndex, { startSeconds: this.status === 'ended' || this.status === 'error' ? 0 : this.position });
      return;
    }
    this.wantPlaying = true;
    this._cmd({ type: 'play' });
    if (this.status === 'paused' || this.status === 'idle') this.status = 'playing';
    this._update();
  }

  pause() {
    if (!this.loadedId) return;
    this.wantPlaying = false;
    this._cmd({ type: 'pause' });
    if (this.status === 'playing' || this.status === 'loading') this.status = 'paused';
    this._update();
  }

  toggle() {
    const active = this.loadedId && this.wantPlaying && this.status !== 'ended' && this.status !== 'error';
    if (active) this.pause(); else this.play();
  }

  next() {
    const n = this.nextIndex;
    if (n < 0) { this._notice('info', 'Es el último video de la lista.'); return false; }
    return this._load(n);
  }

  prev() {
    const i = this.currentIndex;
    if (i < 0) return false;
    if (this.position > 3 && this.loadedId) { this.restart(); return true; }
    if (i > 0) return this._load(i - 1);
    if (this.repeat === 'all' && this.queue.length > 1) return this._load(this.queue.length - 1);
    this.restart();
    return true;
  }

  seekTo(seconds) {
    if (!this.loadedId || !Number.isFinite(seconds)) return;
    const max = this.duration > 0 ? this.duration : Math.max(seconds, 0);
    this.position = clamp(seconds, 0, max);
    this._cmd({ type: 'seek', seconds: this.position });
    this._update();
  }
  seekBy(delta) { this.seekTo(this.position + delta); }

  restart() {
    if (!this.loadedId || this.status === 'ended' || this.status === 'error') { this.play(); return; }
    this.seekTo(0);
    this.play();
  }

  stop() {
    this._clearSkip();
    if (this.loadedId) this._cmd({ type: 'stop' });
    this.loadedId = null;
    this.status = 'idle';
    this.wantPlaying = false;
    this.position = 0;
    this.duration = 0;
    this.error = null;
    this._update();
  }

  setVolume(v) {
    if (!Number.isFinite(v)) return;
    this.volume = clamp(Math.round(v), 0, 100);
    if (this.volume > 0) this.muted = false;
    this._cmd({ type: 'volume', volume: this.volume, muted: this.muted });
    this._update();
  }
  setMuted(m) {
    this.muted = !!m;
    this._cmd({ type: 'volume', volume: this.volume, muted: this.muted });
    this._update();
  }
  setRepeat(mode) {
    if (!['off', 'one', 'all'].includes(mode)) return;
    this.repeat = mode;
    this._update();
  }
  setAutoplay(on) {
    this.autoplay = !!on;
    this._update();
  }

  // ---------- eventos de la pantalla de reproducción ----------
  displayClosed() {
    this.displayReady = false;
    if (this.status === 'playing') this.status = 'loading';
    this._update();
  }

  onDisplayEvent(ev) {
    if (!ev || typeof ev.type !== 'string') return;
    const item = this.current;

    switch (ev.type) {
      case 'ready': {
        this.displayReady = true;
        this.displayOnline = true;
        if (item && this.loadedId === item.id) {
          const ended = this.status === 'ended' || this.status === 'error';
          this._cmd({
            type: 'load', videoId: item.videoId,
            startSeconds: ended ? 0 : this.position,
            autoplay: this.wantPlaying && !ended,
            volume: this.volume, muted: this.muted
          });
        } else {
          this._cmd({ type: 'idle' });
          this._cmd({ type: 'volume', volume: this.volume, muted: this.muted });
        }
        this._update();
        return;
      }
      case 'online': {
        this.displayOnline = !!ev.online;
        if (!this.displayOnline) this._notice('error', 'La pantalla de reproducción perdió la conexión a Internet. Usa «Reintentar» cuando vuelva.');
        this._update();
        return;
      }
    }

    // Eventos ligados a un video: se ignoran si pertenecen a uno anterior.
    if (!item || this.loadedId !== item.id || ev.videoId !== item.videoId) return;

    switch (ev.type) {
      case 'state':
        if (ev.state === 1) {
          this.status = 'playing';
          this.wantPlaying = true;
          this._errStreak = 0;
          if (!item.played) { item.played = true; this._touchQueue(); }
          this._update();
        } else if (ev.state === 2) {
          if (this.status !== 'ended') { this.status = 'paused'; this.wantPlaying = false; this._update(); }
        } else if (ev.state === 3) {
          if (this.status !== 'ended') { this.status = 'loading'; this._update(); }
        } else if (ev.state === 0) {
          this._ended();
        }
        return;

      case 'time': {
        if (Number.isFinite(ev.position)) this.position = Math.max(0, ev.position);
        if (Number.isFinite(ev.duration) && ev.duration > 0) {
          this.duration = ev.duration;
          if (!item.duration) {
            item.duration = Math.floor(ev.duration);
            this._touchQueue();
            this._update();
            return;
          }
        }
        this.emit('time', { position: this.position, duration: this.duration });
        return;
      }

      case 'meta':
        if (typeof ev.title === 'string' && ev.title && (!item.title || /^Video [\w-]{11}$/.test(item.title))) {
          item.title = ev.title.slice(0, 300);
          this._touchQueue();
          this._update();
        }
        return;

      case 'error': {
        const msg = ERRORS[ev.code] || `Error de reproducción (código ${ev.code}).`;
        item.error = msg;
        this._touchQueue();
        this.status = 'error';
        this.wantPlaying = false;
        this.error = msg;
        this._errStreak++;
        this._notice('error', `«${item.title}»: ${msg}`);
        this._update();
        const n = this.nextIndex;
        if (this.autoplay && n >= 0 && n !== this.currentIndex && this._errStreak < this.queue.length) {
          const failedId = item.id;
          this._clearSkip();
          this._skipTimer = setTimeout(() => {
            this._skipTimer = null;
            if (this.currentId === failedId && this.status === 'error') {
              this._notice('info', 'Se omitió el video con error y continúa con el siguiente.');
              this._load(this.nextIndex);
            }
          }, this.skipDelayMs);
        }
        return;
      }
    }
  }

  _ended() {
    const item = this.current;
    if (item && !item.played) { item.played = true; this._touchQueue(); }
    this.position = this.duration;
    if (this.repeat === 'one') { this._load(this.currentIndex); return; }
    if (!this.autoplay) { this.status = 'ended'; this.wantPlaying = false; this._update(); return; }
    const n = this.nextIndex;
    if (n >= 0) { this._load(n); return; }
    this.status = 'ended';
    this.wantPlaying = false;
    this._update();
  }
}

module.exports = { PlaybackController, ERRORS };
