// ── R2-backed backup target (ADR-005 extension point) ────────────────────
import { BackupTarget } from '../server/services/backups.js';

export class R2BackupTarget extends BackupTarget {
  constructor(bucket, prefix = 'backups') {
    super();
    this.bucket = bucket;
    this.prefix = prefix;
  }
  async save(name, produced) {
    const key = `${this.prefix}/${name}`;
    await this.bucket.put(key, produced.bytes, { httpMetadata: { contentType: 'application/json' } });
    return { storedPath: key, size: produced.bytes.length };
  }
  async remove(storedPath) {
    await this.bucket.delete(storedPath);
  }
}
