#!/usr/bin/env node
/**
 * Inbox triage service.
 *
 * Receives inbox webhooks, triages messages, and creates tickets.
 */
'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { triageMessage } = require('./triage');
const { buildTicketPayload , createTicketWithRetry} = require('./ticketing');

function num(v, d) {
  const n = Number(v);
  return v === undefined || v === '' || Number.isNaN(n) ? d : n;
}

const PORT = num(process.env.PORT, 3000);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'whsec_test_do_not_use_in_prod';
const CHANNELS = new Set(['in_app', 'email', 'app_store']);
const PLANS = new Set(['free', 'pro', 'team']);
const events = new Map();
const deadLetters = new Map();
const queue = [];
let workerRunning = false;
const metrics = {
  received: 0,
  duplicates_ignored: 0,
  unknown_type_ignored: 0,
  signature_rejected: 0,
  triaged: 0,
  triage_fallbacks: 0,
  tickets_created: 0,
  downstream_retries: 0,
  dead_lettered: 0,
};

function log(fields) {
  console.log(JSON.stringify({ time: new Date().toISOString(), ...fields }));
}
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

function addDeadLetter(key, entry) {
    metrics.dead_lettered += 1;
    deadLetters.set(key, { ...entry, dead_lettered_at: new Date().toISOString()});
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifySignature(rawBody, signature) {
  if (typeof signature !== 'string') return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);
  return (
    expectedBuffer.length === signatureBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, signatureBuffer)
  );
}

function validateEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return 'event must be a JSON object';
  }
  if (typeof event.event_id !== 'string' || !event.event_id) {
    return 'event_id must be a non-empty string';
  }
  if (typeof event.type !== 'string' || !event.type) {
    return 'type must be a non-empty string';
  }
  if (event.type !== 'message.received') return null;
  if (typeof event.occurred_at !== 'string' || !event.occurred_at) {
    return 'occurred_at must be a non-empty string';
  }
  if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) {
    return 'data must be a JSON object';
  }
  if (typeof event.data.message_id !== 'string' || !event.data.message_id) {
    return 'data.message_id must be a non-empty string';
  }
  if (!CHANNELS.has(event.data.channel)) {
    return 'data.channel is invalid';
  }
  if (!event.data.customer || typeof event.data.customer !== 'object' || Array.isArray(event.data.customer)) {
    return 'data.customer must be a JSON object';
  }
  if (typeof event.data.customer.id !== 'string' || !event.data.customer.id) {
    return 'data.customer.id must be a non-empty string';
  }
  if (!PLANS.has(event.data.customer.plan)) {
    return 'data.customer.plan is invalid';
  }
  if (event.data.subject !== null && typeof event.data.subject !== 'string') {
    return 'data.subject must be a string or null';
  }
  if (typeof event.data.body !== 'string') {
    return 'data.body must be a string';
  }
  if (typeof event.data.locale !== 'string' || !event.data.locale) {
    return 'data.locale must be a non-empty string';
  }

  return null;
}

async function processQueue() {
  if (workerRunning) return;
  workerRunning = true;

  try {
    while (queue.length > 0) {
      const eventId = queue.shift();
      const record = events.get(eventId);

      if (!record || record.status !== 'queued') continue;

      record.status = 'processing';
      let stage = 'triage';

      try {
        if(!record.triage){
            record.triage = await triageMessage(record.event);
            metrics.triaged += 1;
            if (record.triage.status === 'fallback') {
                metrics.triage_fallbacks += 1;
            }
            record.status = 'triaged';
            log({ event_id: eventId, delivery_id: record.deliveryId, stage, attempt: record.triage.meta.attempts, status: record.triage.status});
        }
        if(!record.ticketPayload){
            stage = 'ticket_payload';
            record.ticketPayload = buildTicketPayload(record.event, record.triage);
            record.status = 'ticket_ready';
            log({ event_id: eventId, delivery_id: record.deliveryId, stage, status: 'ready'});
        }
        stage = 'downstream';
        record.status = 'ticketing';
        const result = await createTicketWithRetry(record.ticketPayload);
        metrics.downstream_retries += result.attempts - 1;
        metrics.tickets_created += 1;
        record.downstreamAttempts = result.history;
        record.ticket = result.ticket;
        record.status = 'completed';
        log({ event_id: eventId, delivery_id: record.deliveryId, stage, attempt: result.attempts , status: result.status, replayed: result.replayed});

      } catch (err) {
        if (stage === 'downstream') metrics.downstream_retries += Math.max((err.attempts || 1) - 1, 0);
        record.downstreamAttempts = err.history || [];
        record.status = 'dead_letter';
        record.error = err.message;
        addDeadLetter(eventId, { event_id: eventId, delivery_id: record.deliveryId, stage, reason: err.message, attempt_history: record.downstreamAttempts, event: record.event});
        log({ event_id: eventId, delivery_id: record.deliveryId, stage, attempt: err.attempts, status: err.status || null, error: err.message});
      }
    }
  } finally {
    workerRunning = false;
  }
}

function scheduleWorker() {
  setImmediate(() => {
    processQueue().catch((err) => {
      console.error(err);
    });
  });
}


function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const retryMatch = path.match(/^\/admin\/dead-letters\/([^/]+)\/retry$/);

    try {
      if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true });
      if (req.method === 'GET' && path === '/admin/metrics')    return send(res, 200, metrics);
      if (req.method === 'GET' && path === '/admin/dead-letters') return send(res, 200, [...deadLetters.values()]);
      if (req.method === 'POST' && retryMatch) {
        const eventId = decodeURIComponent(retryMatch[1]);
        if (!deadLetters.has(eventId))  return send(res, 404, { error: 'dead_letter_not_found'});
        const record = events.get(eventId);
        if (!record)    return send(res, 409, { error: 'event_not_reprocessable',});

        deadLetters.delete(eventId);
        record.status = 'queued';
        delete record.error;
        queue.push(eventId);
        scheduleWorker();

        return send(res, 202, {accepted: true, event_id: eventId});
      }
      if (req.method === 'POST' && path === '/webhooks/inbox') {
        metrics.received += 1;
        const rawBody = await readBody(req);
        const signature = req.headers['x-inbox-signature'];
        if (!verifySignature(rawBody, signature)) {
            metrics.signature_rejected += 1;
            return send(res, 401, { error: 'invalid_signature' });
        }
        const deliveryId = typeof req.headers['x-inbox-delivery'] === 'string' ? req.headers['x-inbox-delivery'] : crypto.randomUUID();
        let event;
        try { event = JSON.parse(rawBody.toString('utf8'));
        } catch {
            addDeadLetter(`delivery:${deliveryId}`, { event_id: null, delivery_id: deliveryId, stage: 'webhook', reason: 'invalid_json', attempt_history: [],raw_body: rawBody.toString('utf8')});
            return send(res, 200, { accepted: true, dead_lettered: true});
        }
        const problem = validateEvent(event);
        if (problem) { const key = typeof event.event_id === 'string' ? event.event_id : `delivery:${deliveryId}`;
            addDeadLetter(key, { event_id: typeof event.event_id === 'string' ? event.event_id : null, delivery_id: deliveryId, stage: 'webhook', reason: problem, attempt_history: [], event});
            return send(res, 200, { accepted: true, dead_lettered: true});}
        if (event.type !== 'message.received') {
            metrics.unknown_type_ignored += 1;
            return send(res, 200, { ignored: true });
        }
        if (events.has(event.event_id)) {
            metrics.duplicates_ignored += 1;
            return send(res, 200, {accepted: true, duplicate: true,});
        }

        events.set(event.event_id, { event, deliveryId, status: 'queued',});
        queue.push(event.event_id);
        scheduleWorker();

        return send(res, 202, { accepted: true, duplicate: false,});
      }

      return send(res, 404, { error: 'not_found' });
    } catch (err) {
      console.error(err);
      return send(res, 500, { error: 'internal' });
    }
  });
}

if (require.main === module) {
  const server = createServer();

  server.listen(PORT, () => {
    console.log(`inbox triage service on http://localhost:${PORT}`);
  });
}

module.exports = { createServer };