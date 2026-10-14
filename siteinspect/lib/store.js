// Tiny JSON-file store. The whole db lives in memory and is written to
// <dataDir>/db.json after each change (atomic write: temp file + rename).
// Photos are stored as separate files in <dataDir>/photos.
// Plenty for one site team; swap for a real database if you outgrow it.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const COLLECTIONS = ["projects", "templates", "inspections", "actions"];

function newId() {
  return crypto.randomBytes(8).toString("hex");
}

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.photoDir = path.join(dataDir, "photos");
    this.file = path.join(dataDir, "db.json");
    fs.mkdirSync(this.photoDir, { recursive: true });
    this.db = Object.fromEntries(COLLECTIONS.map((c) => [c, []]));
    if (fs.existsSync(this.file)) {
      const loaded = JSON.parse(fs.readFileSync(this.file, "utf8"));
      for (const c of COLLECTIONS) if (Array.isArray(loaded[c])) this.db[c] = loaded[c];
    }
    this.writing = Promise.resolve();
  }

  // Serialise writes so two quick changes can't interleave on disk.
  save() {
    const snapshot = JSON.stringify(this.db);
    this.writing = this.writing.then(async () => {
      const tmp = this.file + ".tmp";
      await fs.promises.writeFile(tmp, snapshot);
      await fs.promises.rename(tmp, this.file);
    });
    return this.writing;
  }

  list(collection, filter = () => true) {
    return this.db[collection].filter(filter);
  }

  get(collection, id) {
    return this.db[collection].find((r) => r.id === id) || null;
  }

  async insert(collection, record) {
    const now = new Date().toISOString();
    const rec = { ...record, id: newId(), createdAt: now, updatedAt: now };
    this.db[collection].push(rec);
    await this.save();
    return rec;
  }

  async update(collection, id, changes) {
    const rec = this.get(collection, id);
    if (!rec) return null;
    Object.assign(rec, changes, { id, createdAt: rec.createdAt, updatedAt: new Date().toISOString() });
    await this.save();
    return rec;
  }

  async remove(collection, id) {
    const before = this.db[collection].length;
    this.db[collection] = this.db[collection].filter((r) => r.id !== id);
    if (this.db[collection].length === before) return false;
    await this.save();
    return true;
  }

  async removeWhere(collection, pred) {
    this.db[collection] = this.db[collection].filter((r) => !pred(r));
    await this.save();
  }

  // --- photos ---------------------------------------------------------------
  async savePhoto(buf, ext) {
    const id = newId() + ext;
    await fs.promises.writeFile(path.join(this.photoDir, id), buf);
    return id;
  }

  photoPath(id) {
    if (!/^[a-f0-9]{16}\.(jpg|png|webp)$/.test(id)) return null;
    return path.join(this.photoDir, id);
  }
}

module.exports = { Store, newId };
