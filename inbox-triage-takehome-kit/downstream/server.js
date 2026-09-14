#!/usr/bin/env node
/**
 * Mock Ticketing API for the Inbox Triage take-home.
 *
 * It is DELIBERATELY unreliable:
 *   - a fraction of POSTs fail with 500/503           (FAIL_RATE, default 0.3)
 *   - every Nth POST is rate limited with 429 + Retry-After (RATE_LIMIT_EVERY, default 7)
 *   - a fraction of POSTs create the ticket and then HANG for HANG_MS before answering
 *     (TIMEOUT_RATE, default 0.1) -- your client will time out first, but the ticket exists.
 *
 * It honours an `Idempotency-Key` header the way Stripe does:
 *   - same key + same payload  -> 200 with the original ticket and `Idempotent-Replayed: true`
 *   - same key + different payload -> 422 (not retryable)
 *
 * Zero dependencies. Node 18+.
 *
 *   DOWNSTREAM_PORT=4000 FAIL_RATE=0.3 TIMEOUT_RATE=0.1 RATE_LIMIT_EVERY=7 node downstream/server.js
 *   SEED=42 node downstream/server.js        # deterministic failure injection
 *   FAIL_RATE=0 TIMEOUT_RATE=0 RATE_LIMIT_EVERY=0 node downstream/server.js   # well-behaved mode
 *
 * Endpoints
 *   POST   /tickets        create a ticket (see README / brief for the payload)
 *   GET    /tickets        list all tickets
 *   GET    /tickets/:id    one ticket
 *   GET    /stats          counters, incl. duplicate detection by external_ref
 *   DELETE /tickets        reset everything (for tests)
 *   GET    /health
 */
'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

function num(v, d) {
  const n = Number(v);
  return v === undefined || v === '' || Number.isNaN(n) ? d : n;
}

const PORT = num(process.env.DOWNSTREAM_PORT, 4000);
const FAIL_RATE = num(process.env.FAIL_RATE, 0.3);
const TIMEOUT_RATE = num(process.env.TIMEOUT_RATE, 0.1);
const HANG_MS = num(process.env.HANG_MS, 15000);
const RATE_LIMIT_EVERY = num(process.env.RATE_LIMIT_EVERY, 7);
const RETRY_AFTER_S = num(process.env.RETRY_AFTER_S, 2);
const QUIET = !!process.env.QUIET;

// Optional deterministic RNG (mulberry32) when SEED is set.
function makeRng(seed) {
  if (seed === undefined || seed === '') return Math.random;
  let a = Number(seed) >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = makeRng(process.env.SEED);

const CATEGORIES = new Set(['billing', 'bug', 'feature_request', 'account_access', 'abuse_report', 'other']);
const PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3']);
const CHANNELS = new Set(['in_app', 'email', 'app_store']);
const REQUIRED = ['external_ref', 'customer_id', 'channel', 'category', 'priority', 'summary', 'needs_human'];

let state;
function reset() {
  state = {
    tickets: new Map(), // ticket_id -> ticket
    idem: new Map(), // idempotency key -> { hash, ticket_id }
    postCounter: 0,
    stats: {
      requests: 0,
      created: 0,
      idempotent_replays: 0,
      injected_5xx: 0,
      injected_hangs: 0,
      rate_limited_429: 0,
      rejected_400: 0,
      rejected_422: 0,
      posts_without_idempotency_key: 0,
    },
  };
}
reset();

function validate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body must be a JSON object';
  for (const f of REQUIRED) if (!(f in body)) return `missing field: ${f}`;
  if (typeof body.external_ref !== 'string' || !body.external_ref) return 'external_ref must be a non-empty string';
  if (typeof body.customer_id !== 'string' || !body.customer_id) return 'customer_id must be a non-empty string';
  if (!CHANNELS.has(body.channel)) return `channel must be one of: ${[...CHANNELS].join(', ')}`;
  if (!CATEGORIES.has(body.category)) return `category must be one of: ${[...CATEGORIES].join(', ')}`;
  if (!PRIORITIES.has(body.priority)) return `priority must be one of: ${[...PRIORITIES].join(', ')}`;
  if (typeof body.summary !== 'string' || body.summary.length < 1 || body.summary.length > 200) {
    return 'summary must be a string of 1-200 characters';
  }
  if (typeof body.needs_human !== 'boolean') return 'needs_human must be a boolean';
  return null;
}

// Stable stringify so key order does not affect the idempotency hash.
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function send(res, status, body, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(data),
    ...headers,
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function log(...args) {
  if (!QUIET) console.log(new Date().toISOString(), '[downstream]', ...args);
}

function statsView() {
  const refs = new Set();
  for (const t of state.tickets.values()) refs.add(t.external_ref);
  return {
    tickets: state.tickets.size,
    unique_external_refs: refs.size,
    duplicate_tickets: state.tickets.size - refs.size,
    ...state.stats,
    config: { FAIL_RATE, TIMEOUT_RATE, HANG_MS, RATE_LIMIT_EVERY, RETRY_AFTER_S },
  };
}

async function createTicket(req, res) {
  state.stats.requests++;
  const raw = await readBody(req);

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    state.stats.rejected_400++;
    return send(res, 400, { error: 'invalid_json' });
  }
  const problem = validate(body);
  if (problem) {
    state.stats.rejected_400++;
    log('400', problem, body && body.external_ref);
    return send(res, 400, { error: 'validation_error', detail: problem });
  }

  const key = req.headers['idempotency-key'];
  const bodyHash = sha256(canonical(body));
  if (key) {
    const seen = state.idem.get(key);
    if (seen) {
      if (seen.hash !== bodyHash) {
        state.stats.rejected_422++;
        log('422 Idempotency-Key reused with a different payload', key);
        return send(res, 422, { error: 'idempotency_key_reused_with_different_payload', idempotency_key: key });
      }
      state.stats.idempotent_replays++;
      log('200 idempotent replay', body.external_ref, key);
      return send(res, 200, state.tickets.get(seen.ticket_id), { 'idempotent-replayed': 'true' });
    }
  } else {
    state.stats.posts_without_idempotency_key++;
  }

  // ---- failure injection (new requests only; replays above are always served) ----
  const n = ++state.postCounter;
  if (RATE_LIMIT_EVERY > 0 && n % RATE_LIMIT_EVERY === 0) {
    state.stats.rate_limited_429++;
    log('429', body.external_ref, `Retry-After: ${RETRY_AFTER_S}`);
    return send(res, 429, { error: 'rate_limited', retry_after_seconds: RETRY_AFTER_S }, { 'retry-after': String(RETRY_AFTER_S) });
  }
  if (rand() < FAIL_RATE) {
    state.stats.injected_5xx++;
    const code = n % 2 ? 503 : 500;
    log(code, body.external_ref);
    return send(res, code, { error: 'upstream_unavailable' });
  }

  const ticket = {
    ticket_id: 'tkt_' + crypto.randomBytes(6).toString('hex'),
    created_at: new Date().toISOString(),
    ...body,
  };
  state.tickets.set(ticket.ticket_id, ticket);
  if (key) state.idem.set(key, { hash: bodyHash, ticket_id: ticket.ticket_id });
  state.stats.created++;

  if (rand() < TIMEOUT_RATE) {
    // The ticket now exists, but the caller will not hear back in time.
    state.stats.injected_hangs++;
    log('HANG', body.external_ref, `(created ${ticket.ticket_id}, answering in ${HANG_MS} ms)`);
    setTimeout(() => send(res, 201, ticket), HANG_MS);
    return;
  }

  log('201', body.external_ref, ticket.ticket_id, key ? '' : '(no Idempotency-Key!)');
  return send(res, 201, ticket);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  try {
    if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true });
    if (req.method === 'GET' && path === '/stats') return send(res, 200, statsView());
    if (req.method === 'GET' && path === '/tickets') {
      const list = [...state.tickets.values()].sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
      return send(res, 200, list);
    }
    if (req.method === 'GET' && path.startsWith('/tickets/')) {
      const t = state.tickets.get(path.slice('/tickets/'.length));
      return t ? send(res, 200, t) : send(res, 404, { error: 'not_found' });
    }
    if (req.method === 'DELETE' && path === '/tickets') {
      reset();
      log('reset');
      return send(res, 200, { ok: true, reset: true });
    }
    if (req.method === 'POST' && path === '/tickets') return await createTicket(req, res);
    return send(res, 404, { error: 'not_found' });
  } catch (err) {
    log('error', err);
    send(res, 500, { error: 'internal' });
  }
});

server.listen(PORT, () => {
  console.log(
    `mock ticketing API on http://localhost:${PORT}  ` +
      `FAIL_RATE=${FAIL_RATE} TIMEOUT_RATE=${TIMEOUT_RATE} HANG_MS=${HANG_MS} RATE_LIMIT_EVERY=${RATE_LIMIT_EVERY}` +
      (process.env.SEED ? ` SEED=${process.env.SEED}` : ''),
  );
});
