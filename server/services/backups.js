// ── Backup engine · Strategy abstraction (FR-7, ADR-005) ──────────────────
//
//   BackupEngine ──uses──▶ BackupFormat (SQLiteSnapshot | JSONDump)   [what]
//                     └──▶ BackupTarget (LocalDisk · R2 · S3-ready)   [where]
//   BackupScheduler ──reads── backup_config (admin policy)           [when]
//
// The admin console configures *policy*; this engine owns *mechanism*.
// New formats or targets are additive classes — no route/UI changes.
//
// This module is shared between the Node server and the Cloudflare Worker,
// so it stays free of node:fs / node:sqlite. Node-only formats/targets
// (SQLiteSnapshotFormat, LocalDiskTarget) live in backups-node.js; the
// Worker supplies JSONDumpFormat + an R2-backed target instead.
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

// ── Formats ───────────────────────────────────────────────────────────────
export class BackupFormat {
  get id() { throw new Error('not implemented'); }
  async produce(db, dbFile, scope, destPath) { throw new Error('not implemented'); }
}

/** Human-readable, diffable JSON export of the scoped tables. */
export class JSONDumpFormat extends BackupFormat {
  get id() { return 'json'; }
  async produce(db, dbFile, scope) {
    const payload = {
      meta: { product: 'Shire Jama LMS', scope, generated_at: nowIso(), format: 'json-dump/1' },
      tables: {},
    };
    for (const t of SCOPES[scope]) {
      payload.tables[t] = await db.prepare(`SELECT * FROM ${t}`).all();
    }
    return { bytes: Buffer.from(JSON.stringify(payload, null, 1), 'utf8') };
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
    this.ready = this._ensureDefaults();
  }

  async _cfgGet(key, fallback) {
    const row = await this.db.prepare('SELECT value FROM backup_config WHERE key = ?').get(key);
    return row ? row.value : fallback;
  }

  async _cfgSet(key, value) {
    await this.db.prepare(`
      INSERT INTO backup_config (key, value) VALUES (?,?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(value));
  }

  async _ensureDefaults() {
    const any = await this.db.prepare('SELECT 1 FROM backup_config').get();
    if (!any) {
      await this._cfgSet('enabled', '0');
      await this._cfgSet('frequency', 'daily');
      await this._cfgSet('scope', 'full');
      await this._cfgSet('format', [...this.formats.keys()][0] ?? 'json');
      await this._cfgSet('retention', String(this.retentionDefault));
      await this._cfgSet('last_run', '');
      await this._cfgSet('next_run', '');
    }
  }

  async config() {
    await this.ready;
    return {
      enabled: (await this._cfgGet('enabled', '0')) === '1',
      frequency: await this._cfgGet('frequency', 'daily'),
      scope: await this._cfgGet('scope', 'full'),
      format: await this._cfgGet('format', 'json'),
      retention: Number(await this._cfgGet('retention', this.retentionDefault)),
      last_run: (await this._cfgGet('last_run', '')) || null,
      next_run: (await this._cfgGet('next_run', '')) || null,
    };
  }

  async updateConfig(patch) {
    const cur = await this.config();
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
    await this._cfgSet('enabled', next.enabled ? '1' : '0');
    await this._cfgSet('frequency', next.frequency);
    await this._cfgSet('scope', next.scope);
    await this._cfgSet('format', next.format);
    await this._cfgSet('retention', String(next.retention));
    if (next.enabled && FREQUENCIES[next.frequency]) {
      const prevNext = next.next_run ? Date.parse(next.next_run) : 0;
      if (!prevNext || prevNext < Date.now()) {
        await this._cfgSet('next_run', new Date(Date.now() + FREQUENCIES[next.frequency]).toISOString());
      }
    } else {
      await this._cfgSet('next_run', '');
    }
    return await this.config();
  }

  async history() {
    return await this.db.prepare(
      'SELECT id, file_name, scope, format, size_bytes, status, created_at FROM backups ORDER BY id DESC LIMIT 200'
    ).all();
  }

  /** Runs a backup now (admin-triggered or scheduler). */
  async run({ scope, format } = {}) {
    const cfg = await this.config();
    const useScope = SCOPES[scope ?? cfg.scope] ? (scope ?? cfg.scope) : 'full';
    const fmt = this.formats.get(format ?? cfg.format) ?? [...this.formats.values()][0];

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const baseName = `shirejama-backup-${useScope}-${stamp}`;
    const { lastId } = await this.db.prepare(`
      INSERT INTO backups (file_name, stored_path, scope, format, size_bytes, status, created_at)
      VALUES ('', '', ?, ?, 0, 'running', ?)
    `).run(useScope, fmt.id, nowIso());

    try {
      const produced = await fmt.produce(this.db, this.dbFile, useScope);
      const finalName = `${baseName}.${fmt.id === 'sqlite' ? 'db' : 'json'}`;
      const { storedPath, size } = await this.target.save(finalName, produced);
      await this.db.prepare('UPDATE backups SET file_name=?, stored_path=?, size_bytes=?, status=? WHERE id=?')
        .run(finalName, storedPath, size, 'ok', lastId);
      await this._cfgSet('last_run', nowIso());
      log.info('backup_completed', { id: lastId, scope: useScope, format: fmt.id, size });
      await this.prune();
      return await this.db.prepare('SELECT * FROM backups WHERE id = ?').get(lastId);
    } catch (e) {
      await this.db.prepare("UPDATE backups SET status='failed' WHERE id=?").run(lastId);
      log.error('backup_failed', { id: lastId, err: e.message });
      throw e instanceof AppError ? e
        : new AppError(500, 'internal_error', `Backup failed: ${e.message}`);
    }
  }

  /** Retention pruning — keeps the newest N per policy. */
  async prune() {
    const keep = (await this.config()).retention;
    const rows = await this.db.prepare(
      'SELECT id, stored_path FROM backups WHERE status != ? ORDER BY id DESC').all('running');
    for (const r of rows.slice(keep)) {
      await this.db.prepare('DELETE FROM backups WHERE id = ?').run(r.id);
      if (r.stored_path) await this.target.remove(r.stored_path).catch(() => {});
    }
  }

  async download(id) {
    const row = await this.db.prepare('SELECT * FROM backups WHERE id = ?').get(id);
    if (!row || row.status !== 'ok') throw notFound('Backup not found.');
    return row;
  }

  async remove(id) {
    const row = await this.db.prepare('SELECT * FROM backups WHERE id = ?').get(id);
    if (!row) throw notFound('Backup not found.');
    await this.db.prepare('DELETE FROM backups WHERE id = ?').run(id);
    if (row.stored_path) await this.target.remove(row.stored_path).catch(() => {});
    return { ok: true };
  }
}

// ── Scheduler (interval-driven; policy lives in backup_config) ────────────
// Node runs this on a setInterval timer (see server/index.js). The Worker
// instead drives BackupEngine.run() straight from a Cron Trigger, since
// Workers isolates have no persistent timers between requests.
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
    const cfg = await this.engine.config();
    if (!cfg.enabled || !FREQUENCIES[cfg.frequency]) return;
    const next = cfg.next_run ? Date.parse(cfg.next_run) : 0;
    if (!next || Date.now() < next) return;
    log.info('backup_scheduled_run', { scope: cfg.scope, format: cfg.format });
    try {
      await this.engine.run({});
    } finally {
      const freq = FREQUENCIES[cfg.frequency];
      await this.engine._cfgSet('next_run', freq ? new Date(Date.now() + freq).toISOString() : '');
    }
  }
}
