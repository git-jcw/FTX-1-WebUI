// FTX Deck desktop app: the same web app, in its own window, on a pinned
// Electron/Chromium (the one VS Code 1.140 uses, Chromium 150), so browser
// updates can't change how audio reaches the radio.
//
// Electron has no permission prompts or serial-port picker of its own, so this
// file supplies them: microphone, audio output and serial are allowed for the
// app's own page, and the radio's "Enhanced COM" port is chosen automatically.

const { app, BrowserWindow, dialog, session, shell } = require('electron');
const path = require('node:path');

const PAGE = path.join(__dirname, '..', 'dist', 'ftx-deck.html');
const ALLOWED = new Set(['media', 'speaker-selection', 'serial']);

// One copy at a time: two would fight over the radio's COM port and audio.
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;

function isOwnPage(url) {
  try { return new URL(url).protocol === 'file:'; } catch { return false; }
}

function grantPermissions() {
  const s = session.defaultSession;
  s.setPermissionRequestHandler((wc, permission, callback, details) =>
    callback(ALLOWED.has(permission) && isOwnPage(details.requestingUrl || wc.getURL())));
  s.setPermissionCheckHandler((wc, permission, origin) =>
    ALLOWED.has(permission) && (isOwnPage(origin) || origin === 'file://' || isOwnPage(wc?.getURL() || '')));
  s.setDevicePermissionHandler(details => details.deviceType === 'serial');
}

// Pick the radio's CAT port. The FTX-1 appears as two ports; only the
// "Enhanced COM Port" is for CAT (the Standard one's lines can key the radio).
function choosePort(event, portList, webContents, callback) {
  event.preventDefault();
  const label = p => p.displayName ? `${p.displayName}` : p.portName;
  const decide = list => {
    const enhanced = list.filter(p => /enhanced/i.test(label(p)));
    if (enhanced.length === 1) return callback(enhanced[0].portId);
    const candidates = enhanced.length ? enhanced : list;
    if (!candidates.length) {
      dialog.showMessageBox(win, { type: 'warning', title: 'FTX Deck', message: 'No serial ports found.',
        detail: 'Check the USB cable is in the radio\'s side-panel USB jack, the radio is on, and the CP210x USB driver is installed.' });
      return callback('');
    }
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question', title: 'FTX Deck', message: 'Choose the radio\'s CAT port',
      detail: 'Pick the "Enhanced COM Port". The Standard one can key the transmitter.',
      buttons: [...candidates.map(label), 'Cancel'], cancelId: candidates.length, noLink: true,
    });
    callback(choice < candidates.length ? candidates[choice].portId : '');
  };
  if (portList.length) return decide(portList);
  // The list can arrive a moment later.
  const added = [];
  const onAdded = (e, port) => added.push(port);
  session.defaultSession.on('serial-port-added', onAdded);
  setTimeout(() => { session.defaultSession.off('serial-port-added', onAdded); decide(added); }, 1500);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1600, height: 1000, minWidth: 1100, minHeight: 700,
    title: 'FTX Deck', backgroundColor: '#0a0e13', autoHideMenuBar: true, show: false,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  win.once('ready-to-show', () => win.show());
  win.loadFile(PAGE);
  // Links (such as the manual) open in the normal browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!isOwnPage(url)) { e.preventDefault(); shell.openExternal(url); } });
  session.defaultSession.on('select-serial-port', choosePort);
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(() => { grantPermissions(); createWindow(); });
app.on('window-all-closed', () => app.quit());
