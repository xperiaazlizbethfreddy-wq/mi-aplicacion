'use strict';
/** Persistencia local en JSON (escritura atómica y con retardo). */

const fs = require('fs');
const path = require('path');

const DEFAULT_SHORTCUTS = {
  toggle: 'Space',
  next: 'ArrowRight',
  prev: 'ArrowLeft',
  add: 'Ctrl+O',
  save: 'Ctrl+S',
  fullscreen: 'F11'
};

function defaults() {
  return {
    session: null,
    settings: {
      displayId: null,
      fullscreen: true,
      resumeOnStart: false,
      presentation: false,
      shortcuts: { ...DEFAULT_SHORTCUTS },
      apiKey: ''
    },
    playlists: [],
    history: []
  };
}

class Store {
  constructor(file) {
    this.file = file;
    this.data = defaults();
    this._timer = null;
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const d = defaults();
      this.data = {
        session: raw.session || null,
        settings: {
          ...d.settings,
          ...(raw.settings || {}),
          shortcuts: { ...DEFAULT_SHORTCUTS, ...((raw.settings && raw.settings.shortcuts) || {}) }
        },
        playlists: Array.isArray(raw.playlists) ? raw.playlists : [],
        history: Array.isArray(raw.history) ? raw.history : []
      };
    } catch {
      this.data = defaults();
    }
  }

  save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 400);
  }

  flush() {
    clearTimeout(this._timer);
    this._timer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('No se pudo guardar los datos:', e.message);
    }
  }
}

module.exports = { Store, DEFAULT_SHORTCUTS };
