const { contextBridge, ipcRenderer } = require('electron');

// The only things the page may ask the desktop shell to do.
contextBridge.exposeInMainWorld('hispace', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  notify: (payload) => ipcRenderer.send('notify', payload),
  setBadge: (dataUrl) => ipcRenderer.send('badge', dataUrl),
  onNotificationClick: (cb) => ipcRenderer.on('notification-click', (_e, payload) => cb(payload))
});
