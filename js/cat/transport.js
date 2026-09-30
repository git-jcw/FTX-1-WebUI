// Byte transports for CAT. Both classes expose the same small interface:
//   await open()   await close()   write(text)
//   onData = text => {}   onClose = reason => {}   label (string)

export class WebSerialTransport {
  constructor({ baud = 38400, port = null } = {}) {
    this.baud = baud;
    this.port = port;
    this.onData = () => {};
    this.onClose = () => {};
    this._reader = null;
    this._writer = null;
    this._closing = false;
    this.label = 'USB serial';
  }

  static supported() {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
  }

  // Ask the user to pick a port. Silicon Labs CP210x is what the FTX-1 enumerates as.
  static async choosePort() {
    return navigator.serial.requestPort({ filters: [{ usbVendorId: 0x10c4 }] })
      .catch(() => navigator.serial.requestPort());
  }

  async open() {
    if (!this.port) this.port = await WebSerialTransport.choosePort();
    await this.port.open({ baudRate: this.baud, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none', bufferSize: 4096 });
    // Keep RTS/DTR low: on the Standard COM port they can key the transmitter.
    try { await this.port.setSignals({ requestToSend: false, dataTerminalReady: false }); } catch { /* not all drivers support it */ }
    const info = this.port.getInfo?.() || {};
    this.label = info.usbVendorId ? `USB ${info.usbVendorId.toString(16)}:${(info.usbProductId || 0).toString(16)} @ ${this.baud}` : `serial @ ${this.baud}`;
    this._writer = this.port.writable.getWriter();
    this._readLoop();
  }

  async _readLoop() {
    const decoder = new TextDecoder();
    let reason = 'closed';
    try {
      while (this.port.readable && !this._closing) {
        this._reader = this.port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this._reader.read();
            if (done) break;
            if (value) this.onData(decoder.decode(value, { stream: true }));
          }
        } finally {
          this._reader.releaseLock();
        }
      }
    } catch (e) {
      reason = e?.message || 'read error';
    }
    if (!this._closing) this.onClose(reason);
  }

  write(text) {
    if (!this._writer) return Promise.reject(new Error('port not open'));
    return this._writer.write(new TextEncoder().encode(text));
  }

  async close() {
    this._closing = true;
    try { await this._reader?.cancel(); } catch { /* ignore */ }
    try { this._writer?.releaseLock(); } catch { /* ignore */ }
    try { await this.port?.close(); } catch { /* ignore */ }
    this._writer = null;
    this.onClose('closed');
  }
}
