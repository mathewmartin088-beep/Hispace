// Tiny JSON-file database with debounced atomic writes.
const fs = require('fs');
const path = require('path');

class DB {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'hispace-data.json');
    this.tmp = this.file + '.tmp';
    this.data = { users: {}, servers: {}, messages: {}, sessions: {} };
    this.timer = null;
    fs.mkdirSync(dir, { recursive: true });
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = Object.assign({ users: {}, servers: {}, messages: {}, sessions: {} }, parsed);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Keep a copy of an unreadable file instead of silently overwriting it.
        try { fs.copyFileSync(this.file, this.file + '.corrupt-' + Date.now()); } catch (_) {}
        console.error('[hispace] Could not read data file, starting fresh:', err.message);
      }
    }
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 400);
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try {
      fs.writeFileSync(this.tmp, JSON.stringify(this.data));
      fs.renameSync(this.tmp, this.file);
    } catch (err) {
      console.error('[hispace] Failed to save data:', err.message);
    }
  }
}

module.exports = DB;
