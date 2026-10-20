'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set(['state', 'time', 'notice', 'displays', 'library']);

contextBridge.exposeInMainWorld('api', {
  init: () => ipcRenderer.invoke('init'),
  cmd: (c) => ipcRenderer.invoke('cmd', c),
  on: (channel, cb) => {
    if (!EVENTS.has(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => cb(payload));
  }
});
