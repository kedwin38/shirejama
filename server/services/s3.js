// ── S3-compatible storage client · zero dependencies ─────────────────────
// AWS Signature V4 over WebCrypto — runs identically in Cloudflare Workers
// and Node 18+. Works with any S3-compatible service: Amazon S3, Cloudflare
// R2's S3 API, DigitalOcean Spaces, Backblaze B2, Wasabi, MinIO…
//
// Used by the backup engine (server/services/backups.js) to write, read,
// and prune backup objects in a bucket the ADMIN connects via the console.

const enc = new TextEncoder();
const subtle = crypto.subtle;

const sha256Hex = async (data) => {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  const buf = await subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const hmac = async (keyBytes, data) => {
  const key = await subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', key, enc.encode(data)));
};

const uriEncode = (s) => encodeURIComponent(String(s)).replace(
  /[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** Build the SigV4 Authorization header. */
async function signHeaders({ method, canonicalUri, host, region, accessKeyId, secretAccessKey, payloadHash, extraHeaders = {} }) {
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const signed = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...Object.fromEntries(Object.entries(extraHeaders).map(([k, v]) => [k.toLowerCase(), v])),
  };
  const sortedKeys = Object.keys(signed).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${signed[k]}\n`).join('');
  const signedHeaders = sortedKeys.join(';');
  const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');

  let key = enc.encode(`AWS4${secretAccessKey}`);
  for (const part of [dateStamp, region, 's3', 'aws4_request']) key = await hmac(key, part);
  const sig = [...await hmac(key, stringToSign)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
  };
}

/** Object URL for the configured endpoint (virtual-host on AWS, path-style elsewhere). */
export function objectUrl({ endpoint, bucket, key }) {
  const base = String(endpoint).replace(/\/+$/, '');
  const path = base.split('/').slice(3).join('/'); // strip scheme+host
  const objectPart = key.split('/').map(uriEncode).join('/');
  if (/\.amazonaws\.com$/.test(new URL(base).hostname)) {
    return `${base.replace('://', `://${bucket}.`)}/${objectPart}`;
  }
  return `${base}/${bucket}/${objectPart}` + (path ? '' : '');
}

/**
 * Perform a signed S3 request. `body` may be a string or Uint8Array.
 * Returns the fetch Response (2xx/3xx not thrown — check .ok).
 */
export async function s3Request({ method, endpoint, region, bucket, key, body, accessKeyId, secretAccessKey, contentType }) {
  const url = new URL(objectUrl({ endpoint, bucket, key }));
  const payload = body == null ? new Uint8Array(0)
    : (typeof body === 'string' ? enc.encode(body) : body);
  const payloadHash = await sha256Hex(payload);
  const extra = {};
  if (contentType) extra['content-type'] = contentType;
  const headers = await signHeaders({
    method, canonicalUri: url.pathname, host: url.host, region,
    accessKeyId, secretAccessKey, payloadHash, extraHeaders: extra,
  });
  return fetch(url, {
    method,
    headers: { ...headers, ...(contentType ? { 'content-type': contentType } : {}) },
    body: method === 'GET' || method === 'HEAD' || method === 'DELETE' ? undefined : payload,
  });
}

export async function s3Put(cfg, key, body, contentType = 'application/json') {
  return s3Request({ ...cfg, method: 'PUT', key, body, contentType });
}
export async function s3Get(cfg, key) {
  return s3Request({ ...cfg, method: 'GET', key });
}
export async function s3Delete(cfg, key) {
  return s3Request({ ...cfg, method: 'DELETE', key });
}

/** Round-trip a tiny object — proves credentials, endpoint, and bucket. */
export async function s3TestConnection(cfg) {
  const probe = (cfg.prefix ? cfg.prefix.replace(/\/+$/, '') + '/' : '') + '.connection-test';
  const put = await s3Put(cfg, probe, 'shirejama-lms connectivity probe', 'text/plain');
  if (!put.ok) {
    const detail = (await put.text().catch(() => '')).slice(0, 200);
    throw new Error(`S3 write test failed (${put.status}): ${detail || put.statusText}`);
  }
  const del = await s3Delete(cfg, probe);
  if (!del.ok && del.status !== 204) {
    throw new Error(`S3 delete test failed (${del.status}).`);
  }
  return { ok: true };
}
