// Serialises CAT traffic over one transport.
//
// - One command on the wire at a time, so replies can't interleave.
// - Reads resolve with the reply text (matched by replyKey), or null on
//   timeout / "?;".
// - Writes (set commands) wait a short gap so a "?;" rejection is caught
//   and attributed to the right command instead of the next read.
// - Sets jump ahead of queued polls, and a newer set with the same
//   `coalesce` key replaces an older one still waiting (e.g. fast tuning).

import { splitReplies, replyKey } from './ftx1.js';

export class CatLink {
  constructor(transport, { readTimeoutMs = 350, setGapMs = 12, onTraffic = () => {}, onError = () => {} } = {}) {
    this.t = transport;
    this.readTimeoutMs = readTimeoutMs;
    this.setGapMs = setGapMs;
    this.onTraffic = onTraffic;
    this.onError = onError;
    this._buf = '';
    this._queue = [];
    this._pending = null;
    this._busy = false;
    this.closed = false;
    this.stats = { sent: 0, received: 0, timeouts: 0, rejected: 0 };
    this.t.onData = text => this._onData(text);
  }

  // Read: returns Promise<reply|null>
  read(command, { priority = false } = {}) {
    return this._enqueue({ command, expect: replyKey(command), priority });
  }

  // Set: returns Promise<boolean> (false if the radio answered "?;")
  set(command, { coalesce = null } = {}) {
    if (coalesce) {
      const old = this._queue.find(q => q.coalesce === coalesce);
      if (old) { old.command = command; return old.promise; }
    }
    return this._enqueue({ command, expect: null, priority: true, coalesce });
  }

  _enqueue(item) {
    if (this.closed) return Promise.resolve(item.expect ? null : false);
    item.promise = new Promise(res => { item.resolve = res; });
    if (item.priority) {
      // after other priority items, ahead of polls
      const idx = this._queue.findIndex(q => !q.priority);
      if (idx < 0) this._queue.push(item); else this._queue.splice(idx, 0, item);
    } else {
      this._queue.push(item);
    }
    this._pump();
    return item.promise;
  }

  // Drop queued polls (e.g. when a new poll cycle starts and the old one is stale).
  clearPolls() {
    for (const q of this._queue) if (!q.priority) q.resolve(null);
    this._queue = this._queue.filter(q => q.priority);
  }

  get queueLength() { return this._queue.length; }

  async _pump() {
    if (this._busy || this.closed) return;
    this._busy = true;
    try {
      while (this._queue.length && !this.closed) {
        const item = this._queue.shift();
        await this._run(item);
      }
    } finally {
      this._busy = false;
    }
  }

  async _run(item) {
    const result = await new Promise(resolve => {
      const done = v => { clearTimeout(timer); this._pending = null; resolve(v); };
      const waitMs = item.expect ? this.readTimeoutMs : this.setGapMs;
      const timer = setTimeout(() => {
        if (item.expect) { this.stats.timeouts++; done(null); } else done(true);
      }, waitMs);
      this._pending = { item, done };
      this.stats.sent++;
      this.onTraffic('tx', item.command);
      this.t.write(item.command).catch(e => { this.onError(e); done(item.expect ? null : false); });
    });
    item.resolve(result);
  }

  _onData(text) {
    this._buf += text;
    if (this._buf.length > 8192) this._buf = this._buf.slice(-1024); // runaway guard
    const { replies, rest } = splitReplies(this._buf);
    this._buf = rest;
    for (const r of replies) {
      this.stats.received++;
      this.onTraffic('rx', r);
      const p = this._pending;
      if (!p) continue; // unsolicited (AI mode) — ignored; we poll instead
      if (r === '?;') {
        this.stats.rejected++;
        p.done(p.item.expect ? null : false);
      } else if (p.item.expect && replyKey(r) === p.item.expect) {
        p.done(r);
      }
    }
  }

  close() {
    this.closed = true;
    for (const q of this._queue) q.resolve(q.expect ? null : false);
    this._queue = [];
    this._pending?.done(null);
  }
}
