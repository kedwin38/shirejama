// ── Backup engine · Strategy abstraction (FR-7, ADR-005) ──────────────────
//
//   BackupEngine ──uses──▶ BackupFormat (SQLiteSnapshot | JSONDump)   [what]
//                     └──▶ BackupTarget (LocalDisk · S3-ready port)   [where]
//   BackupScheduler ──reads── backup_config (admin policy)           [when]
//
// The admin console configures *policy*; this engine owns *mechanism*.
// New formats or targets are additive classes — no route/UI changes.
import { createWriteStream, readdirSync, statSync, unlinkSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { AppError, badRequest, notFound } from '../core/errors.js';
import { nowIso } from '../core/validate.js';
import { log } from '../core/log.js';

// Which tables belong to each scope (see docs/03_DATA_MODEL.md).
export const SCOPES = Object.freeze({
  accounts: ['users'],
  results: ['courses', 'course_levels', 'chapters', 'materials', 'quizzes',
            'questions', 'options', 'attempts', 'answers', 'progress', 'users'],
  full: ['users', 'courses', 'course_levels', 'chapters', 'materials', 'quizzes',
         'questions', 'options', 'attempts', 'answers', 'progress'],
});

const FREQUENCIES = { off: 0, '6h': 6 * 3600e3, daily: 24 * 3600e3, weekly: 7 * 24 * 3600e3 };

// ── Targets ───────────────────────────────────────────────────────────────
export class BackupTarget {
  async save(name, sourcePath) { throw new Error('not implemented'); }
  async list() { throw new Error('not implemented'); }
  async open(name) { throw new Error('not implemented'); }
  async remove(name) { throw new Error('not implemented'); }
}

export class LocalDiskTarget extends BackupTarget {
  constructor(dir) { super(); this.dir = dir; }
  async save(name, sourcePath) {
    const dest = join(this.dir, name);
    copyFileSync(sourcePath, dest); // engine writes to temp first (atomic-ish)
    return dest;
  }
  async open(name) { return join(this.dir, name); }
}

// S3Target/FTPTarget slot in here later — same 4 methods, zero call-site edits.

// ── Formats ───────────────────────────────────────────────────────────────
export class BackupFormat {
  get id() { throw new Error('not implemented'); }
  async produce(db, dbFile, scope, destPath) { throw new Error('not implemented'); }
}

/** Consistent online snapshot via VACUUM INTO, pruned to the scope. */
export class SQLiteSnapshotFormat extends BackupFormat {
  get id() { return 'sqlite'; }
  async produce(db, dbFile, scope, destPath) {
    const tmp = `${destPath}.tmp`;
    // VACUUM INTO yields a transactionally consistent copy while live.
    db.prepare('VACUUM INTO ?').run(tmp);
    const keep = SCOPES[scope];
    // Engine/runtime tables never travel inside backups.
    const never = ['sessions', 'backup_config', 'backups'];
    const snap = new DatabaseSync(tmp);
    try {
      // FK-safe purge order (children before parents).
      const purgeOrder = ['answers', 'attempts', 'progress', 'options', 'questions',
                          'quizzes', 'materials', 'chapters', 'course_levels',
                          'courses', 'sessions', 'users'];
      snap.exec('PRAGMA foreign_keys = OFF;');
      for (const t of purgeOrder) {
        if (!keep.includes(t) || never.includes(t)) snap.exec(`DELETE FROM ${t};`);
      }
    } finally {
      snap.close();
    }
    return { path: tmp, finalName: destPath };
  }
}

/** Human-readable, diffable JSON export of the scoped tables. */
export class JSONDumpFormat extends BackupFormat {
  get id() { return 'json'; }
  async produce(db, dbFile, scope, destPath) {
    const payload = {
      meta: { product: 'Shire Jama LMS', scope, generated_at: nowIso(), format: 'json-dump/1' },
      tables: {},
    };
    for (const t of SCOPES[scope]) {
      payload.tables[t] = db.prepare(`SELECT * FROM ${t}`).all();
    }
    const tmp = `${destPath}.tmp`;
    await new Promise((resolve, reject) => {
      const out = createWriteStream(tmp, { flags: 'wx' });
      out.on('error', reject);
      out.end(JSON.stringify(payload, null, 1), resolve);
    });
    return { path: tmp, finalName: destPath };
  }
}

// ── Engine ────────────────────────────────────────────────────────────────
export class BackupEngine {
  constructor(db, dbFile, { target, formats, retentionDefault = 10 }) {
    this.db = db;
    this.dbFile = dbFile;
    this.target = target;                     // BackupTarget
    this.formats = new Map(formats.map((f) => [f.id, f])); // BackupFormat[]
    this.retentionDefault = retentionDefault;
    this._ensureDefaults();
  }

  _cfgGet(key, fallback) {
    const row = this.db.prepare('SELECT value FROM backup_config WHERE key = ?').get(key);
    return row ? row.value : fallback;
  }

  _cfgSet(key, value) {
    this.db.prepare(`
      INSERT INTO backup_config (key, value) VALUES (?,?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(value));
  }

  _ensureDefaults() {
    if (!this.db.prepare('SELECT 1 FROM backup_config').get()) {
      this._cfgSet('enabled', '0');
      this._cfgSet('frequency', 'daily');
      this._cfgSet('scope', 'full');
      this._cfgSet('format', 'sqlite');
      this._cfgSet('retention', String(this.retentionDefault));
      this._cfgSet('last_run', '');
      this._cfgSet('next_run', '');
    }
  }

  config() {
    return {
      enabled: this._cfgGet('enabled', '0') === '1',
      frequency: this._cfgGet('frequency', 'daily'),
      scope: this._cfgGet('scope', 'full'),
      format: this._cfgGet('format', 'sqlite'),
      retention: Number(this._cfgGet('retention', this.retentionDefault)),
      last_run: this._cfgGet('last_run', '') || null,
      next_run: this._cfgGet('next_run', '') || null,
    };
  }

  updateConfig(patch) {
    const cur = this.config();
    const next = { ...cur };
    if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
    if (patch.frequency !== undefined) {
      if (!FREQUENCIES[patch.frequency]) throw badRequest('Unknown backup frequency.');
      next.frequency = patch.frequency;
    }
    if (patch.scope !== undefined) {
      if (!SCOPES[patch.scope]) throw badRequest('Unknown backup scope.');
      next.scope = patch.scope;
    }
    if (patch.format !== undefined) {
      if (!this.formats.has(patch.format)) throw badRequest('Unknown backup format.');
      next.format = patch.format;
    }
    if (patch.retention !== undefined) {
      const r = Number(patch.retention);
      if (!Number.isInteger(r) || r < 1 || r > 200) throw badRequest('Retention must be between 1 and 200.');
      next.retention = r;
    }
    this._cfgSet('enabled', next.enabled ? '1' : '0');
    this._cfgSet('frequency', next.frequency);
    this._cfgSet('scope', next.scope);
    this._cfgSet('format', next.format);
    this._cfgSet('retention', String(next.retention));
    if (next.enabled && FREQUENCIES[next.frequency]) {
      const prevNext = next.next_run ? Date.parse(next.next_run) : 0;
      if (!prevNext || prevNext < Date.now()) {
        this._cfgSet('next_run', new Date(Date.now() + FREQUENCIES[next.frequency]).toISOString());
      }
    } else {
      this._cfgSet('next_run', '');
    }
    return this.config();
  }

  history() {
    return this.db.prepare('SELECT id, file_name, scope, format, size_bytes, status, created_at FROM backups ORDER BY id DESC LIMIT 200').all();
  }

  /** Runs a backup now (admin-triggered or scheduler). */
  async run({ scope, format } = {}) {
    const cfg = this.config();
    const useScope = SCOPES[scope ?? cfg.scope] ? (scope ?? cfg.scope) : 'full';
    const fmt = this.formats.get(format ?? cfg.format) ?? this.formats.get('sqlite');

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const baseName = `shirejama-backup-${useScope}-${stamp}`;
    const workName = `${baseName}.work`;
    const { lastId } = this.db.prepare(`
      INSERT INTO backups (file_name, stored_path, scope, format, size_bytes, status, created_at)
      VALUES ('', '', ?, ?, 0, 'running', ?)
    `).run(useScope, fmt.id, nowIso());

    try {
      const produced = await fmt.produce(this.db, this.dbFile, useScope, join(this.target.dir, workName));
      const finalName = `${baseName}.${fmt.id === 'sqlite' ? 'db' : 'json'}`;
      const storedPath = await this.target.save(finalName, produced.path);
      try { unlinkSync(produced.path); } catch {} // remove temp work file
      const size = statSync(storedPath).size;
      this.db.prepare('UPDATE backups SET file_name=?, stored_path=?, size_bytes=?, status=? WHERE id=?')
        .run(finalName, storedPath, size, 'ok', lastId);
      this._cfgSet('last_run', nowIso());
      log.info('backup_completed', { id: lastId, scope: useScope, format: fmt.id, size });
      await this.prune();
      return this.db.prepare('SELECT * FROM backups WHERE id = ?').get(lastId);
    } catch (e) {
      this.db.prepare("UPDATE backups SET status='failed' WHERE id=?").run(lastId);
      log.error('backup_failed', { id: lastId, err: e.message });
      throw e instanceof AppError ? e
        : new AppError(500, 'internal_error', `Backup failed: ${e.message}`);
    }
  }

  /** Retention pruning — keeps the newest N per policy. */
  async prune() {
    const keep = this.config().retention;
    const rows = this.db.prepare(
      'SELECT id, stored_path FROM backups WHERE status != ? ORDER BY id DESC').all('running');
    for (const r of rows.slice(keep)) {
      this.db.prepare('DELETE FROM backups WHERE id = ?').run(r.id);
      try { if (r.stored_path) unlinkSync(r.stored_path); } catch {}
    }
  }

  download(id) {
    const row = this.db.prepare('SELECT * FROM backups WHERE id = ?').get(id);
    if (!row || row.status !== 'ok') throw notFound('Backup not found.');
    if (!existsSync(row.stored_path)) throw notFound('The backup file is missing from storage.');
    return row;
  }

  async remove(id) {
    const row = this.db.prepare('SELECT * FROM backups WHERE id = ?').get(id);
    if (!row) throw notFound('Backup not found.');
    this.db.prepare('DELETE FROM backups WHERE id = ?').run(id);
    try { if (row.stored_path) unlinkSync(row.stored_path); } catch {}
    return { ok: true };
  }
}

// ── Scheduler (interval-driven; policy lives in backup_config) ────────────
export class BackupScheduler {
  constructor(engine, { tickMs = 5 * 60e3 } = {}) {
    this.engine = engine;
    this.tickMs = tickMs;
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch((e) =>
      log.error('scheduler_tick_failed', { err: e.message })), this.tickMs);
    this.timer.unref?.();
    log.info('backup_scheduler_started', { tickMs: this.tickMs });
  }

  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  async tick() {
    const cfg = this.engine.config();
    if (!cfg.enabled || !FREQUENCIES[cfg.frequency]) return;
    const next = cfg.next_run ? Date.parse(cfg.next_run) : 0;
    if (!next || Date.now() < next) return;
    log.info('backup_scheduled_run', { scope: cfg.scope, format: cfg.format });
    try {
      await this.engine.run({});
    } finally {
      const freq = FREQUENCIES[cfg.frequency];
      this.engine._cfgSet('next_run', freq ? new Date(Date.now() + freq).toISOString() : '');
    }
  }
}
