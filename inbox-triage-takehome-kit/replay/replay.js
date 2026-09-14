#!/usr/bin/env node
/**
 * Replays webhook deliveries at your service the way the real inbox provider would,
 * then inspects the mock ticketing API and prints PASS / FAIL.
 *
 * Provider behaviour it emulates:
 *   - at-least-once delivery: any delivery not acknowledged with 2xx within 5 s is retried,
 *     with a NEW X-Inbox-Delivery id each time (up to 3 attempts here; the real provider
 *     keeps trying for 72 hours)
 *   - some events are delivered twice at the same instant, some again 3 s later
 *   - delivery order is shuffled
 *   - body formatting is not stable: half the deliveries are pretty-printed
 *   - one delivery has an invalid signature, one is truncated JSON (but correctly signed),
 *     one is missing data.body, three are event types you should ignore
 *
 * Zero dependencies. Node 18+.
 *
 *   node replay/replay.js            # replay + verify
 *   node replay/replay.js --reset    # reset the mock downstream first (restart your service too!)
 *   node replay/replay.js --quiet    # one line per delivery group instead of per attempt
 *
 * Environment (all optional):
 *   WEBHOOK_URL=http://localhost:3000/webhooks/inbox   DOWNSTREAM_URL=http://localhost:4000
 *   WEBHOOK_SECRET=whsec_test_do_not_use_in_prod       CONCURRENCY=8   SETTLE_SECONDS=45
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function num(v, d) {
  const n = Number(v);
  return v === undefined || v === '' || Number.isNaN(n) ? d : n;
}

const WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://localhost:3000/webhooks/inbox';
const SERVICE_ORIGIN = new URL(WEBHOOK_URL).origin;
const DOWNSTREAM_URL = (process.env.DOWNSTREAM_URL || 'http://localhost:4000').replace(/\/$/, '');
const SECRET = process.env.WEBHOOK_SECRET || 'whsec_test_do_not_use_in_prod';
const CONCURRENCY = num(process.env.CONCURRENCY, 8);
const PROVIDER_TIMEOUT_MS = num(process.env.PROVIDER_TIMEOUT_MS, 5000);
const PROVIDER_MAX_ATTEMPTS = num(process.env.PROVIDER_MAX_ATTEMPTS, 3);
const PROVIDER_RETRY_DELAY_MS = num(process.env.PROVIDER_RETRY_DELAY_MS, 2000);
const DUP_DELAY_MS = num(process.env.DUP_DELAY_MS, 3000);
const SETTLE_SECONDS = num(process.env.SETTLE_SECONDS, 45);
const RESET = process.argv.includes('--reset');
const QUIET = process.argv.includes('--quiet');

const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'events.json'), 'utf8'));
const VALID_SCENARIOS = new Set(['normal', 'dup_concurrent', 'dup_delayed']);
const expectedTickets = fixtures.filter((f) => VALID_SCENARIOS.has(f.scenario));
const expectedIds = new Set(expectedTickets.map((f) => f.event.event_id));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sign(raw, secret) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(raw, 'utf8').digest('hex');
}

function buildBody(fx, index) {
  // The provider's JSON formatting is not stable between deliveries.
  let raw = index % 2 === 0 ? JSON.stringify(fx.event, null, 2) : JSON.stringify(fx.event);
  if (fx.scenario === 'malformed_json') raw = raw.slice(0, Math.floor(raw.length * 0.8));
  return raw;
}

async function deliver(fx, raw, label) {
  const secret = fx.scenario === 'bad_signature' ? SECRET + '-not-the-real-secret' : SECRET;
  const result = { label, event_id: fx.event.event_id, scenario: fx.scenario, attempts: [], final: null };

  for (let attempt = 1; attempt <= PROVIDER_MAX_ATTEMPTS; attempt++) {
    const deliveryId = crypto.randomUUID();
    const started = Date.now();
    let status = null;
    let error = null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROVIDER_TIMEOUT_MS);
    try {
      const res = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-inbox-delivery': deliveryId,
          'x-inbox-signature': sign(raw, secret),
          'user-agent': 'InboxProvider-Webhooks/1.0',
        },
        body: raw,
        signal: ctrl.signal,
      });
      status = res.status;
      await res.arrayBuffer(); // drain
    } catch (e) {
      error = e.name === 'AbortError' ? 'timeout' : (e.cause && e.cause.code) || e.message;
    } finally {
      clearTimeout(timer);
    }
    const ms = Date.now() - started;
    result.attempts.push({ attempt, delivery_id: deliveryId, status, error, ms });
    if (!QUIET) {
      console.log(
        `  ${fx.event.event_id.padEnd(30)} ${label.padEnd(24)} attempt ${attempt}  ` +
          `${status !== null ? status : error}  ${ms} ms`,
      );
    }
    if (status !== null && status >= 200 && status < 300) {
      result.final = 'acked';
      break;
    }
    if (attempt < PROVIDER_MAX_ATTEMPTS) {
      await sleep(PROVIDER_RETRY_DELAY_MS * attempt);
    } else {
      result.final = 'gave_up';
    }
  }
  return result;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function pool(jobs, size) {
  const out = [];
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const i = next++;
      out[i] = await jobs[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, jobs.length) }, worker));
  return out;
}

async function getJson(url, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function hr(title) {
  console.log('\n' + (title ? `── ${title} ` : '').padEnd(72, '─'));
}

async function main() {
  hr('Inbox Triage replay');
  console.log(`webhook:    ${WEBHOOK_URL}`);
  console.log(`downstream: ${DOWNSTREAM_URL}`);
  console.log(`fixtures:   ${fixtures.length} events, ${expectedTickets.length} of which must become tickets`);

  // ---- preflight ----
  try {
    await getJson(`${DOWNSTREAM_URL}/health`);
  } catch (e) {
    console.error(`\nFAIL: mock downstream not reachable at ${DOWNSTREAM_URL} (${e.message}). Start it with: npm run downstream`);
    process.exit(2);
  }
  try {
    await getJson(`${SERVICE_ORIGIN}/health`);
  } catch (e) {
    console.warn(`\nwarning: GET ${SERVICE_ORIGIN}/health failed (${e.message}) -- continuing anyway`);
  }
  if (RESET) {
    await fetch(`${DOWNSTREAM_URL}/tickets`, { method: 'DELETE' });
    console.log('downstream reset. Restart your service too, otherwise every event will look like a duplicate to it.');
  }
  const before = await getJson(`${DOWNSTREAM_URL}/stats`);
  console.log(`downstream before: ${before.tickets} tickets (${before.duplicate_tickets} duplicates)`);

  // ---- delivery plan ----
  const jobs = [];
  fixtures.forEach((fx, i) => {
    const raw = buildBody(fx, i);
    switch (fx.scenario) {
      case 'dup_concurrent':
        jobs.push(() => Promise.all([deliver(fx, raw, 'original'), deliver(fx, raw, 'duplicate (concurrent)')]));
        break;
      case 'dup_delayed':
        jobs.push(async () => {
          const a = await deliver(fx, raw, 'original');
          await sleep(DUP_DELAY_MS);
          const b = await deliver(fx, raw, `duplicate (+${DUP_DELAY_MS / 1000} s)`);
          return [a, b];
        });
        break;
      default:
        jobs.push(async () => [await deliver(fx, raw, fx.scenario)]);
    }
  });
  shuffle(jobs);

  hr(`delivering (concurrency ${CONCURRENCY})`);
  const t0 = Date.now();
  const results = (await pool(jobs, CONCURRENCY)).flat();
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  // ---- delivery summary ----
  hr('delivery summary');
  const attempts = results.reduce((n, r) => n + r.attempts.length, 0);
  const acked = results.filter((r) => r.final === 'acked').length;
  const gaveUp = results.filter((r) => r.final === 'gave_up');
  console.log(`deliveries: ${results.length}   attempts: ${attempts}   provider retries: ${attempts - results.length}   acked: ${acked}   gave up: ${gaveUp.length}   (${elapsed} s)`);

  const byScenario = new Map();
  for (const r of results) {
    const s = byScenario.get(r.scenario) || { count: 0, statuses: new Map() };
    s.count++;
    for (const a of r.attempts) {
      const k = a.status !== null ? String(a.status) : a.error;
      s.statuses.set(k, (s.statuses.get(k) || 0) + 1);
    }
    byScenario.set(r.scenario, s);
  }
  for (const [scenario, s] of [...byScenario.entries()].sort()) {
    const statuses = [...s.statuses.entries()].map(([k, v]) => `${k}×${v}`).join('  ');
    console.log(`  ${scenario.padEnd(16)} ${String(s.count).padStart(3)} deliveries   responses: ${statuses}`);
  }
  for (const r of gaveUp) {
    console.log(`  provider gave up on ${r.event_id} (${r.scenario}) after ${r.attempts.length} attempts -- it would keep retrying for 72 h in production`);
  }

  const slow = results.flatMap((r) => r.attempts).filter((a) => a.ms > 2000 && a.status !== null && a.status < 300);
  if (slow.length) console.log(`  note: ${slow.length} acknowledgements took > 2 s -- the provider retries anything slower than ${PROVIDER_TIMEOUT_MS / 1000} s`);

  // ---- wait for the pipeline to drain ----
  hr(`waiting for the pipeline to settle (max ${SETTLE_SECONDS} s)`);
  let last = null;
  let stableMs = 0;
  const deadline = Date.now() + SETTLE_SECONDS * 1000;
  let stats = before;
  while (Date.now() < deadline) {
    stats = await getJson(`${DOWNSTREAM_URL}/stats`);
    if (last && stats.tickets === last.tickets && stats.requests === last.requests) stableMs += 2000;
    else stableMs = 0;
    last = stats;
    process.stdout.write(`\r  tickets: ${stats.tickets}  requests: ${stats.requests}  5xx injected: ${stats.injected_5xx}  429s: ${stats.rate_limited_429}  hangs: ${stats.injected_hangs}   `);
    if (stableMs >= 8000 && stats.tickets >= expectedTickets.length) break;
    if (stableMs >= 16000) break;
    await sleep(2000);
  }
  console.log('');

  // ---- verify ----
  hr('verification');
  const tickets = await getJson(`${DOWNSTREAM_URL}/tickets`);
  const refs = tickets.map((t) => t.external_ref);
  const unexpected = [...new Set(refs.filter((r) => !expectedIds.has(r)))];
  const missing = [...expectedIds].filter((id) => !refs.includes(id));
  const checks = [
    [`exactly ${expectedTickets.length} tickets (got ${stats.tickets})`, stats.tickets === expectedTickets.length],
    [`0 duplicate tickets by external_ref (got ${stats.duplicate_tickets})`, stats.duplicate_tickets === 0],
    [`no ticket for rejected / ignored events${unexpected.length ? ' (got: ' + unexpected.join(', ') + ')' : ''}`, unexpected.length === 0],
    [`every valid event became a ticket${missing.length ? ' (missing: ' + missing.join(', ') + ')' : ''}`, missing.length === 0],
    [`every POST /tickets carried an Idempotency-Key (${stats.posts_without_idempotency_key} without)`, stats.posts_without_idempotency_key === 0],
    [`no 422 idempotency conflicts (got ${stats.rejected_422})`, stats.rejected_422 === 0],
    [`no 400 validation errors from the ticketing API (got ${stats.rejected_400})`, stats.rejected_400 === 0],
  ];
  let pass = true;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}`);
    if (!ok) pass = false;
  }
  console.log(`  info  downstream saw ${stats.requests} POSTs: ${stats.created} created, ${stats.idempotent_replays} idempotent replays, ${stats.injected_5xx} injected 5xx, ${stats.rate_limited_429} 429s, ${stats.injected_hangs} hangs`);

  // ---- your service's own view, if it exposes one ----
  for (const p of ['/admin/metrics', '/admin/dead-letters']) {
    try {
      const data = await getJson(`${SERVICE_ORIGIN}${p}`);
      console.log(`\n  GET ${p}:`);
      console.log('  ' + JSON.stringify(data, null, 2).split('\n').join('\n  '));
    } catch (e) {
      console.log(`\n  GET ${p}: not available (${e.message})`);
    }
  }

  hr();
  console.log(pass ? 'RESULT: PASS' : 'RESULT: FAIL');
  console.log('');
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error('replay crashed:', e);
  process.exit(2);
});
