// Hispace desktop shell: window, tray and notifications. The app connects to the central Hispace server.
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, Notification, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');

app.setAppUserModelId('com.mathew.hispace');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

const ICON = path.join(__dirname, '..', 'public', 'icon.png');
const PAGE = path.join(__dirname, '..', 'public', 'index.html');
const DEFAULTS = { closeToTray: true, launchAtLogin: false };

let win = null;
let tray = null;
let quitting = false;
let hintedTray = false;

/* ---------- settings ---------- */
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = { ...DEFAULTS };
function loadSettings() {
  try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) }; } catch (_) { settings = { ...DEFAULTS }; }
}
function saveSettings() {
  try { fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(settings)); } catch (_) {}
}

/* ---------- window ---------- */
function createWindow(showNow = true) {
  win = new BrowserWindow({
    width: 1240, height: 800, minWidth: 860, minHeight: 560,
    show: false, title: 'Hispace', icon: ICON, backgroundColor: '#130f20',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#130f20', symbolColor: '#aaa3c6', height: 36 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true
    }
  });
  Menu.setApplicationMenu(null);
  win.loadFile(PAGE);
  win.once('ready-to-show', () => { if (showNow) win.show(); });

  // Only the bundled UI may run in this window; web links open in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) { e.preventDefault(); if (/^https?:\/\//i.test(url)) shell.openExternal(url); }
  });
  if (!app.isPackaged) {
    win.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) win.webContents.toggleDevTools();
    });
  }

  win.on('close', (e) => {
    if (!quitting && settings.closeToTray && tray) {
      e.preventDefault();
      win.hide();
      if (!hintedTray && Notification.isSupported()) {
        hintedTray = true;
        new Notification({ title: 'Hispace is still running', body: 'It is in the tray so your calls and server stay up. Right-click the tray icon to quit.', silent: true, icon: ICON }).show();
      }
    }
  });
  win.on('closed', () => { win = null; });
}

function showWindow() {
  if (!win) { createWindow(true); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(ICON).resize({ width: 20, height: 20 });
    tray = new Tray(img);
    tray.setToolTip('Hispace');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Hispace', click: showWindow },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } }
    ]));
    tray.on('click', showWindow);
  } catch (err) {
    tray = null; // No tray available (some Linux setups): closing the window then quits normally.
  }
}

/* ---------- IPC ---------- */
ipcMain.handle('settings:get', () => ({
  closeToTray: settings.closeToTray,
  launchAtLogin: app.getLoginItemSettings().openAtLogin
}));

ipcMain.handle('settings:set', (_e, patch) => {
  if (typeof patch.closeToTray === 'boolean') settings.closeToTray = patch.closeToTray;
  if (typeof patch.launchAtLogin === 'boolean') {
    settings.launchAtLogin = patch.launchAtLogin;
    app.setLoginItemSettings({ openAtLogin: patch.launchAtLogin, args: ['--hidden'] });
  }
  saveSettings();
  return true;
});

ipcMain.on('notify', (_e, p) => {
  if (!p || typeof p.title !== 'string' || !Notification.isSupported()) return;
  const n = new Notification({ title: p.title.slice(0, 80), body: String(p.body || '').slice(0, 200), silent: true, icon: ICON });
  n.on('click', () => { showWindow(); if (win) win.webContents.send('notification-click', { channelId: p.channelId }); });
  n.show();
  if (win && !win.isFocused()) {
    win.flashFrame(true);
    win.once('focus', () => win && win.flashFrame(false));
  }
});

ipcMain.on('badge', (_e, dataUrl) => {
  if (!win) return;
  try {
    if (dataUrl) win.setOverlayIcon(nativeImage.createFromDataURL(dataUrl), 'Unread messages');
    else win.setOverlayIcon(null, '');
  } catch (_) {}
});

/* ---------- lifecycle ---------- */
app.on('second-instance', showWindow);

app.whenReady().then(async () => {
  loadSettings();

  const allowed = new Set(['media', 'audioCapture', 'notifications', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(allowed.has(permission) && wc.getURL().startsWith('file:')));
  session.defaultSession.setPermissionCheckHandler((wc, permission) => allowed.has(permission));

  createTray();
  createWindow(!process.argv.includes('--hidden') || !tray);
});

app.on('before-quit', () => { quitting = true; });

app.on('window-all-closed', () => { if (quitting || !tray || !settings.closeToTray) app.quit(); });
