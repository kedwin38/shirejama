// ── Backup engine · admin-connected S3-compatible storage (FR-7) ─────────
// An administrator connects ANY S3-compatible storage service (Amazon S3,
// Cloudflare R2's S3 API, DigitalOcean Spaces, Backblaze B2, Wasabi, MinIO…)
// by entering its access details once in the Backup Console. From that
// point, backups upload there automatically per schedule or on demand.
//
// Content: the FULL system details — accounts/credentials, students' marks,
// attempts, progress, courses — as a readable JSON dump. Media and uploaded
// files are NEVER included (they live in the media store, not the database).
//
// This module is shared between the Node server and the Cloudflare Worker,
// so it stays free of node:fs / node:sqlite. All S3 I/O goes through the
// portable WebCrypto SigV4 client in ./s3.js.
import { AppError, badRequest, notFound } from '../core/errors.js';
import { nowIso } from '../core/validate.js';
import { log } from '../core/log.js';
import { s3Put, s3Get, s3Delete, s3TestConnection } from './s3.js';

// Which tables belong to each scope (data only — never media/files).
export const SCOPES = Object.freeze({
  accounts: ['users'],
  results: ['courses', 'course_levels', 'chapters', 'materials', 'quizzes',
            'questions', 'options', 'attempts', 'answers', 'progress', 'users'],
  full: ['users', 'courses', 'course_levels', 'chapters', 'materials', 'quizzes',
         'questions', 'options', 'attempts', 'answers', 'progress'],
});

export const FREQUENCIES = { off: 0, '6h': 6 * 3600e3, daily: 24 * 3600e3, weekly: 7 * 24 * 3600e3 };

const enc = new TextEncoder();

export class BackupEngine {
  constructor(db, _unused, { retentionDefault = 10 } = {}) {
    this.db = db;
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
    `).run(key, String(value ?? ''));
  }

  async _ensureDefaults() {
    const any = await this.db.prepare('SELECT 1 FROM backup_config').get();
    if (!any) {
      await this._cfgSet('enabled', '0');
      await this._cfgSet('frequency', 'off');   // off by default until changed
      await this._cfgSet('scope', 'full');
      await this._cfgSet('retention', String(this.retentionDefault));
      await this._cfgSet('last_run', '');
      await this._cfgSet('next_run', '');
    }
  }

  /** Current S3 connection (or null) assembled from stored config. */
  async _s3Config() {
    await this.ready;
    const endpoint = await this._cfgGet('s3_endpoint', '');
    const bucket = await this._cfgGet('s3_bucket', '');
    const accessKeyId = await this._cfgGet('s3_access_key_id', '');
    const secretAccessKey = await this._cfgGet('s3_secret_access_key', '');
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
    return {
      endpoint, bucket, accessKeyId, secretAccessKey,
      region: (await this._cfgGet('s3_region', 'auto')) || 'auto',
      prefix: (await this._cfgGet('s3_prefix', '')).replace(/^\/+|\/+$/g, ''),
    };
  }

  async config() {
    await this.ready;
    const s3 = await this._s3Config();
    return {
      enabled: (await this._cfgGet('enabled', '0')) === '1',
      frequency: await this._cfgGet('frequency', 'off'),
      scope: await this._cfgGet('scope', 'full'),
      retention: Number(await this._cfgGet('retention', this.retentionDefault)),
      last_run: (await this._cfgGet('last_run', '')) || null,
      next_run: (await this._cfgGet('next_run', '')) || null,
      // Connection summary — secret is NEVER returned to the client.
      s3: s3 ? {
        endpoint: s3.endpoint, bucket: s3.bucket, region: s3.region,
        prefix: s3.prefix, access_key_id: s3.accessKeyId.slice(0, 4) + '…' + s3.accessKeyId.slice(-4),
      } : null,
    };
  }

  /**
   * Save policy + connection. Pass s3: null to keep the existing connection;
   * pass explicit fields (including an empty secret to clear) to update it.
   */
  async updateConfig(patch) {
    const cur = await this.config();
    const next = { ...cur };
    if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
    if (patch.frequency !== undefined) {
      if (!(patch.frequency in FREQUENCIES)) throw badRequest('Unknown backup frequency.');
      next.frequency = patch.frequency;
    }
    if (patch.scope !== undefined) {
      if (!SCOPES[patch.scope]) throw badRequest('Unknown backup scope.');
      next.scope = patch.scope;
    }
    if (patch.retention !== undefined) {
      const r = Number(patch.retention);
      if (!Number.isInteger(r) || r < 1 || r > 200) throw badRequest('Retention must be between 1 and 200.');
      next.retention = r;
    }
    await this._cfgSet('enabled', next.enabled ? '1' : '0');
    await this._cfgSet('frequency', next.frequency);
    await this._cfgSet('scope', next.scope);
    await this._cfgSet('retention', String(next.retention));

    if (patch.s3 && typeof patch.s3 === 'object') {
      const { endpoint, region, bucket, access_key_id, secret_access_key, prefix } = patch.s3;
      if (String(endpoint ?? '').trim() && !/^https?:\/\//i.test(String(endpoint).trim())) {
        throw badRequest('The S3 endpoint must start with http:// or https://.');
      }
      if (String(endpoint ?? '').trim()) await this._cfgSet('s3_endpoint', String(endpoint).trim());
      await this._cfgSet('s3_region', String(region ?? 'auto').trim() || 'auto');
      if (String(bucket ?? '').trim()) await this._cfgSet('s3_bucket', String(bucket).trim());
      if (String(access_key_id ?? '').trim()) await this._cfgSet('s3_access_key_id', String(access_key_id).trim());
      // Secret: allow placeholder '********' to mean "unchanged".
      const secret = String(secret_access_key ?? '');
      if (secret && secret !== '********') await this._cfgSet('s3_secret_access_key', secret);
      await this._cfgSet('s3_prefix', String(prefix ?? '').trim());
    }

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

  /** Round-trip a probe object — proves endpoint/credentials/bucket. */
  async testConnection() {
    const s3 = await this._s3Config();
    if (!s3) throw badRequest('Enter the storage connection details first (endpoint, bucket, access key, secret).');
    try {
      await s3TestConnection(s3);
      return { ok: true, message: 'Connected — a test object was written and removed successfully.' };
    } catch (e) {
      throw badRequest(`Connection failed: ${e.message}`);
    }
  }

  async history() {
    return await this.db.prepare(
      'SELECT id, file_name, scope, format, size_bytes, status, created_at FROM backups ORDER BY id DESC LIMIT 200'
    ).all();
  }

  /** Runs a backup now (admin-triggered or scheduler). */
  async run({ scope } = {}) {
    const cfg = await this.config();
    const s3 = await this._s3Config();
    if (!s3) {
      throw badRequest('Connect a cloud storage target first — enter your S3-compatible storage details in the Backup Console.');
    }
    const useScope = SCOPES[scope ?? cfg.scope] ? (scope ?? cfg.scope) : 'full';

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const finalName = `shirejama-backup-${useScope}-${stamp}.json`;
    const key = (s3.prefix ? s3.prefix + '/' : '') + finalName;
    const { lastId } = await this.db.prepare(`
      INSERT INTO backups (file_name, stored_path, scope, format, size_bytes, status, created_at)
      VALUES ('', '', ?, 'json', 0, 'running', ?)
    `).run(useScope, nowIso());

    try {
      const payload = {
        meta: { product: 'Shire Jama LMS', scope: useScope, generated_at: nowIso(), format: 'json-dump/1' },
        tables: {},
      };
      for (const t of SCOPES[useScope]) {
        payload.tables[t] = await this.db.prepare(`SELECT * FROM ${t}`).all();
      }
      const body = JSON.stringify(payload, null, 1);
      const bytes = enc.encode(body);
      const put = await s3Put(s3, key, bytes, 'application/json');
      if (!put.ok) {
        const detail = (await put.text().catch(() => '')).slice(0, 200);
        throw new Error(`storage rejected the upload (${put.status}): ${detail || put.statusText}`);
      }
      const size = bytes.length;
      await this.db.prepare('UPDATE backups SET file_name=?, stored_path=?, size_bytes=?, status=? WHERE id=?')
        .run(finalName, key, size, 'ok', lastId);
      await this._cfgSet('last_run', nowIso());
      log.info('backup_completed', { id: lastId, scope: useScope, size });
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
      if (r.stored_path) {
        const s3 = await this._s3Config();
        if (s3) await s3Delete(s3, r.stored_path).catch(() => {});
      }
    }
  }

  /** Fetch a stored backup's bytes from S3 (download streams from storage). */
  async download(id) {
    const row = await this.db.prepare('SELECT * FROM backups WHERE id = ?').get(id);
    if (!row || row.status !== 'ok') throw notFound('Backup not found.');
    const s3 = await this._s3Config();
    if (!s3) throw badRequest('The storage connection is no longer configured.');
    const res = await s3Get(s3, row.stored_path);
    if (!res.ok) throw notFound('The backup object is missing from the connected storage.');
    return { row, bytes: new Uint8Array(await res.arrayBuffer()) };
  }

  async remove(id) {
    const row = await this.db.prepare('SELECT * FROM backups WHERE id = ?').get(id);
    if (!row) throw notFound('Backup not found.');
    await this.db.prepare('DELETE FROM backups WHERE id = ?').run(id);
    if (row.stored_path) {
      const s3 = await this._s3Config();
      if (s3) await s3Delete(s3, row.stored_path).catch(() => {});
    }
    return { ok: true };
  }

  /** Cron/scheduler tick — respects off-by-default + frequency policy. */
  async tick() {
    const cfg = await this.config();
    if (!cfg.enabled || !FREQUENCIES[cfg.frequency]) return;
    const next = cfg.next_run ? Date.parse(cfg.next_run) : 0;
    if (!next || Date.now() < next) return;
    log.info('backup_scheduled_run', { scope: cfg.scope });
    try {
      await this.run({});
    } finally {
      const freq = FREQUENCIES[cfg.frequency];
      await this._cfgSet('next_run', freq ? new Date(Date.now() + freq).toISOString() : '');
    }
  }
}
