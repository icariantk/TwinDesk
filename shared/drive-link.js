// TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
// TwinDesk Drive over one session (docs/drive.md): shared/drive.js's engine on each side, this in
// between. Loaded only while Drive is on.
//
// Messages, on the session (an app without Drive ignores them, so it never starts):
//   drive.hello  either {v: 1, have?, again?}: Drive is on here. Each side answers once with its own.
//                have {e, n}: where this side last had all of the other's index (shared/drive.js
//                cursor()); again: send it once more (a failed download, the session moved).
//   drive.index  either {entries, last, upto?}: in parts, after both said hello: what changed since
//                the other's have, or everything when it has none of this epoch (an older TwinDesk
//                never says have). upto {e, n}, on the last part: where this index is.
//   drive.update either {entries, r?}: what changed here since. r {e, from, to}, on the last part:
//                the numbers of those changes.
//   drive.want   host->guest {id, p, h}: send me this file (the guest PUTs it).
//   drive.gone   guest->host {id}: I don't have that version any more.
// The bytes go over HTTPS on the session's port, as fast files' do (shared/fastfile.js): the guest
// connects, pinning the host's certificate, and shows the session's fast-files token, which the host
// checks with the address the session came from. The guest GETs what it downloads and PUTs what the
// host asks for. Never through Bluetooth: there Drive waits until the session is on Wi-Fi or a cable.
//
// A side keeps where it is in the other's index (memory.have) only once everything up to there is
// here: every part merged, every download done, nothing the engine left for later. Anything less and
// the next hello asks from the last place it had all, so nothing is skipped. The index goes out in
// parts a little apart, not all at once, and a computer that came back 3 times within a minute waits
// until its link stayed up for a while before Drive says hello again (a flapping network card).
//
// new DriveLink({drive, send, session, peerName, onChange, folder, memory, partGapMs, stableMs})
//   send(msg); session(): {host, token, address, port?, fp?, transport} or null (an app without fast
//   files: Drive doesn't run with it); peerName().
//   folder: one of Multi-device's extra folders (shared/drive-host.js createMesh): its id goes on every
//   message (f) and request (&f=), so the other side finds the folder's own link. '' (the main folder):
//   nothing added, as an older TwinDesk speaks.
//   memory: kept by the caller for that computer (and folder) across its sessions ({have, ups}); a
//   link per session gets the same one back.
'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { pipeline } = require('stream');
const P = require('./protocol.js');

const T = P.T;
const PATH = '/twindesk/drive/';
const HEADER = 'x-twindesk-drive';
const PART = 1000; // entries per message
const PARALLEL = 4;
const WANT_MS = 60000; // a PUT the guest doesn't start by then: given up (tried again later)
const IDLE_MS = 30000;
const RETRY_MS = 30000;
const PART_GAP_MS = 100; // between the index's parts
const FLAP_MS = 60000; // this many reconnects within this long …
const FLAP_COUNT = 3;
const STABLE_MS = 15000; // … and Drive waits this long of a link that stays up

const cursorOk = (c) => !!c && typeof c.e === 'string' && c.e.length <= 64 && Number.isSafeInteger(c.n) && c.n >= 0;

const same = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const plainAddr = (a) => String(a || '').replace(/^::ffff:/, '');

class DriveLink {
  constructor({ drive, send, session, peerName = () => '', onChange = () => {}, folder = '', memory = {}, partGapMs = PART_GAP_MS, stableMs = STABLE_MS }) {
    Object.assign(this, { drive, session, peerName, onChange, memory, partGapMs, stableMs });
    this.q = folder ? '&f=' + encodeURIComponent(folder) : '';
    this.sendFn = folder ? (m) => send({ ...m, f: folder }) : send;
    this.theyHello = false;
    this.saidHello = false;
    this.theirHave = null; // their hello's have: where they are in our index
    this.holding = false;
    this.holdTimer = null;
    this.sendGen = 0; // an index on its way stops when this moves on
    this.candidate = null; // where we'll be in theirs once everything on its way is here
    this.broken = false; // something didn't come: no candidate until their next index
    this.merging = 0;
    this.queue = []; // downloads to do
    this.active = 0;
    this.wants = new Map(); // id -> {pull, resolve, timer} (host: waiting for the guest's PUT)
    this.agent = null;
    this.retryTimer = null;
    this.moving = 0;
    this.onChanged = (entries, range) => this._update(entries, range);
    drive.on('changed', this.onChanged);
  }

  get ready() {
    const s = this.session();
    return this.theyHello && !!s && !!s.token && s.transport !== 'ble';
  }

  // ---- the session ----
  // A session started, or moved off Bluetooth: say Drive is on here.
  start() {
    if (this.holding || this.saidHello) return;
    const now = Date.now();
    this.memory.ups = (this.memory.ups || []).filter((t) => now - t < FLAP_MS);
    this.memory.ups.push(now);
    if (this.memory.ups.length >= FLAP_COUNT) {
      this.holding = true;
      console.log(`[drive] ${this.peerName()}: came back ${this.memory.ups.length} times within a minute, syncing once it stays up ${Math.round(this.stableMs / 1000)} s`);
      this.holdTimer = setTimeout(() => { this.holding = false; this._hello(); }, this.stableMs);
      if (this.holdTimer.unref) this.holdTimer.unref();
      return;
    }
    this._hello();
  }

  _hello() {
    this.saidHello = true;
    this._sayHello();
    if (this.theyHello) this._sendIndex(this.theirHave);
  }

  _sayHello(again = false) {
    const m = { t: T.DRIVE_HELLO, v: 1 };
    if (cursorOk(this.memory.have)) m.have = this.memory.have;
    if (again) m.again = true;
    this.sendFn(m);
  }

  // The session moved (off Bluetooth onto Wi-Fi or a cable): what waited goes now.
  kick() {
    if (!this.ready || this.holding) return;
    this._sayHello(true);
    this._sendIndex(this.theirHave);
  }

  // The session ended: what was on its way waits for the next one.
  stop() {
    this.theyHello = false;
    this.saidHello = false;
    this.theirHave = null;
    this.holding = false;
    clearTimeout(this.holdTimer);
    this.sendGen++;
    this.candidate = null; // what didn't come comes again: the next hello asks from memory.have
    this.broken = false;
    for (const p of this.queue) this.drive.release(p);
    this.queue = [];
    for (const [id, w] of this.wants) this._wantDone(id, w, false);
    clearTimeout(this.retryTimer);
    if (this.agent) this.agent.destroy();
    this.agent = null;
  }

  destroy() {
    this.stop();
    this.drive.removeListener('changed', this.onChanged);
  }

  // A session message: true when it was Drive's.
  onMessage(m) {
    if (!m || typeof m.t !== 'string' || !m.t.startsWith('drive.')) return false;
    if (m.t === T.DRIVE_HELLO) {
      const first = !this.theyHello;
      this.theyHello = true;
      this.theirHave = cursorOk(m.have) ? { e: m.have.e, n: m.have.n } : null;
      if (this.holding) return true; // we say hello (and send ours) once the link stayed up
      if (!this.saidHello) this.start();
      else if (first || m.again) this._sendIndex(this.theirHave); // again: it missed something
    } else if (!this.theyHello) {
      return true;
    } else if (m.t === T.DRIVE_INDEX || m.t === T.DRIVE_UPDATE) {
      if (m.t === T.DRIVE_INDEX) this.broken = false; // an index: it covers what didn't come before
      this._merge(Array.isArray(m.entries) ? m.entries.slice(0, PART) : [], this._mark(m));
    } else if (m.t === T.DRIVE_WANT) {
      this._put(m);
    } else if (m.t === T.DRIVE_GONE) {
      const w = this.wants.get(String(m.id));
      if (w) this._wantDone(String(m.id), w, false);
    }
    return true;
  }

  _send(m) {
    if (this.ready && this.saidHello) this.sendFn(m);
  }

  // Ours, for them: what changed since their have, or everything when it isn't of this epoch. The
  // parts go a little apart; another index, or the session ending, stops this one.
  _sendIndex(have) {
    if (!this.ready) return;
    const upto = this.drive.cursor();
    const since = have && have.e === upto.e && have.n <= upto.n ? have.n : null;
    const all = since === null ? this.drive.entries() : this.drive.entriesSince(since);
    const gen = ++this.sendGen;
    const part = (i) => {
      if (gen !== this.sendGen || !this.ready) return;
      const last = i + PART >= all.length;
      const m = { t: T.DRIVE_INDEX, entries: all.slice(i, i + PART), last };
      if (last) m.upto = upto;
      this.sendFn(m);
      if (!last) {
        const t = setTimeout(() => part(i + PART), this.partGapMs);
        if (t.unref) t.unref();
      }
    };
    part(0);
  }

  _update(entries, range) {
    for (let i = 0; i < entries.length; i += PART) {
      const m = { t: T.DRIVE_UPDATE, entries: entries.slice(i, i + PART) };
      if (range && i + PART >= entries.length) m.r = range;
      this._send(m);
    }
  }

  // Their message's place in their index, when it's the last part: an index's upto, or an update
  // that follows straight on from where we'd be. Taken as ours once all of it is here (_settle).
  _mark(m) {
    if (m.t === T.DRIVE_INDEX) return m.last && cursorOk(m.upto) ? { e: m.upto.e, n: m.upto.n } : null;
    const r = m.r;
    if (!r || typeof r.e !== 'string' || !Number.isSafeInteger(r.from) || !Number.isSafeInteger(r.to) || r.to < r.from) return null;
    const at = this.candidate || this.memory.have;
    return at && at.e === r.e && at.n === r.from ? { e: r.e, n: r.to } : null;
  }

  async _merge(entries, mark) {
    this.merging++;
    if (mark && !this.broken) this.candidate = mark;
    let pulls = [];
    try {
      pulls = await this.drive.merge(entries, this.peerName());
    } catch {
      pulls = Object.defineProperty([], 'deferred', { value: true });
    }
    this.merging--;
    if (pulls.deferred) this._missed();
    if (!this.ready) {
      for (const p of pulls) this.drive.release(p);
      if (pulls.length) this._missed();
      return;
    }
    this.queue.push(...pulls);
    this._next();
    this._settle();
  }

  // Something of theirs didn't come (a download failed, the engine left an entry for later): where we
  // are stays the last place we had all, until their next index.
  _missed() {
    this.candidate = null;
    this.broken = true;
  }

  // Everything on its way is here: where we are in their index now.
  _settle() {
    if (!this.candidate || this.broken || this.merging || this.queue.length || this.active) return;
    this.memory.have = this.candidate;
    this.candidate = null;
  }

  // ---- downloads ----
  _next() {
    while (this.active < PARALLEL && this.queue.length && this.ready) {
      const p = this.queue.shift();
      this.active++;
      this.moving++;
      this.onChange();
      const s = this.session();
      const done = (ok) => {
        this.active--;
        this.moving--;
        if (!ok) { this._missed(); this._retryLater(); }
        this.onChange();
        this._next();
        this._settle();
      };
      (s.host ? this._want(p) : this._get(p, s)).then(done, () => done(false));
    }
  }

  // Failures (the file changed there meanwhile, a dropped connection) come back with the next index.
  _retryLater() {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.ready && this._sayHello(true), RETRY_MS);
    if (this.retryTimer.unref) this.retryTimer.unref();
  }

  // As guest: GET it from the host.
  _get(pull, s) {
    return new Promise((resolve) => {
      const tmp = this.drive.tempPath();
      const out = fs.createWriteStream(tmp);
      const fail = () => { out.destroy(); fs.rm(tmp, { force: true }, () => {}); this.drive.release(pull); resolve(false); };
      const q = `p=${encodeURIComponent(pull.p)}&h=${pull.h}${this.q}`;
      const req = this._request(s, 'GET', PATH + 'f?' + q);
      req.on('response', (res) => {
        if (res.statusCode !== 200) { res.resume(); return fail(); }
        res.setTimeout(IDLE_MS, () => res.destroy());
        pipeline(res, out, (err) => (err ? fail() : this.drive.adopt(pull, tmp).then(resolve, () => resolve(false))));
      });
      req.on('error', fail);
      req.setTimeout(IDLE_MS, () => req.destroy());
    });
  }

  // As host: ask the guest to PUT it here.
  _want(pull) {
    return new Promise((resolve) => {
      const id = crypto.randomBytes(8).toString('hex');
      const timer = setTimeout(() => this._wantDone(id, this.wants.get(id), false), WANT_MS);
      this.wants.set(id, { pull, resolve, timer, started: false });
      this.sendFn({ t: T.DRIVE_WANT, id, p: pull.p, h: pull.h });
    });
  }

  _wantDone(id, w, ok) {
    if (!w || this.wants.get(id) !== w) return;
    this.wants.delete(id);
    clearTimeout(w.timer);
    if (!ok) this.drive.release(w.pull);
    w.resolve(ok);
  }

  // As guest: the host asked for a file: PUT it.
  async _put(m) {
    const id = String(m.id || '').slice(0, 32);
    const s = this.session();
    const src = s && !s.host ? await this.drive.open(m.p, String(m.h || '')) : null;
    if (!src) return this.sendFn({ t: T.DRIVE_GONE, id });
    const q = `id=${id}${this.q}`;
    const req = this._request(s, 'PUT', PATH + 'u?' + q, { 'content-length': src.size });
    req.on('error', () => {});
    req.on('response', (res) => res.resume());
    req.setTimeout(IDLE_MS, () => req.destroy());
    this._pinnedThen(req, s, () => pipeline(fs.createReadStream(src.abs), req, () => {}));
  }

  // A request to the host, with the token, held until its certificate is the paired one's.
  _request(s, method, url, headers = {}) {
    if (!this.agent) this.agent = new https.Agent({ keepAlive: true, maxSockets: PARALLEL + 1, rejectUnauthorized: false, maxCachedSessions: 0 });
    const req = https.request({ host: s.address, port: s.port, method, path: url, agent: this.agent, headers: { [HEADER]: s.token, ...headers } });
    if (method === 'GET') this._pinnedThen(req, s, () => req.end());
    return req;
  }

  _pinnedThen(req, s, go) {
    req.on('socket', (sock) => {
      const check = () => {
        const cert = sock.getPeerCertificate() || {};
        if (!s.fp || !cert.fingerprint256 || P.normFingerprint(cert.fingerprint256) !== s.fp) return req.destroy(new Error('not the paired computer'));
        go();
      };
      if ((sock.getPeerCertificate() || {}).fingerprint256) check();
      else sock.once('secureConnect', check);
    });
  }

  // ---- the host's HTTPS ----
  // true when it was Drive's.
  request(req, res) {
    if (!req.url.startsWith(PATH)) return false;
    const s = this.session();
    const deny = (code) => { res.writeHead(code); res.end(); return true; };
    if (!s || !s.host || !s.token || !this.theyHello || !same(req.headers[HEADER], s.token)) return deny(403);
    if (s.address && plainAddr(req.socket.remoteAddress) !== plainAddr(s.address)) return deny(403);
    let u;
    try { u = new URL(req.url, 'https://x'); } catch { return deny(400); }
    const route = u.pathname.slice(PATH.length);
    if (req.method === 'GET' && route === 'f') {
      this.drive.open(u.searchParams.get('p') || '', u.searchParams.get('h') || '').then((src) => {
        if (!src) return deny(404);
        res.writeHead(200, { 'content-length': src.size, 'content-type': 'application/octet-stream' });
        pipeline(fs.createReadStream(src.abs), res, () => {});
      }, () => deny(500));
      return true;
    }
    if (req.method === 'PUT' && route === 'u') {
      const id = u.searchParams.get('id') || '';
      const w = this.wants.get(id);
      if (!w || w.started) return deny(404);
      w.started = true;
      clearTimeout(w.timer);
      const tmp = this.drive.tempPath();
      const out = fs.createWriteStream(tmp);
      req.setTimeout(IDLE_MS, () => req.destroy());
      pipeline(req, out, (err) => {
        if (err) {
          fs.rm(tmp, { force: true }, () => {});
          this._wantDone(id, w, false);
          return deny(500);
        }
        this.drive.adopt(w.pull, tmp).then((ok) => {
          this._wantDone(id, w, ok);
          deny(ok ? 200 : 409);
        }, () => { this._wantDone(id, w, false); deny(500); });
      });
      return true;
    }
    return deny(404);
  }

  status() {
    return { connected: this.ready, moving: this.moving + this.queue.length };
  }
}

module.exports = { DriveLink, PATH, HEADER };
