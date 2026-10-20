'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('projector', {
  onCommand: (cb) => ipcRenderer.on('display-command', (_e, c) => cb(c)),
  emit: (ev) => ipcRenderer.send('display-event', ev)
});
