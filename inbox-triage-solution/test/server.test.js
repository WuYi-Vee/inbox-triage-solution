'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function waitFor(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;

  while (!check()) {
    if (Date.now() >= deadline) {
      throw new Error('timed out waiting for background work');
    }

    await delay(10);
  }
}

test('concurrent duplicate deliveries create one ticket', async (t) => {
  const ticketRequests = [];

  const downstream = http.createServer(async (req, res) => {
    const chunks = [];

    for await (const chunk of req) {
      chunks.push(chunk);
    }

    const payload = JSON.parse(
      Buffer.concat(chunks).toString('utf8'),
    );

    ticketRequests.push({
      payload,
      idempotencyKey: req.headers['idempotency-key'],
    });

    res.writeHead(201, {
      'content-type': 'application/json',
    });

    res.end(
      JSON.stringify({
        ticket_id: 'tic_concurrent_001',
        ...payload,
      }),
    );
  });

  const downstreamPort = await listen(downstream);
  t.after(() => close(downstream));

  process.env.DOWNSTREAM_URL =
    `http://127.0.0.1:${downstreamPort}`;
  process.env.WEBHOOK_SECRET =
    'whsec_test_do_not_use_in_prod';
  process.env.LLM_PROVIDER = 'mock';

  const { createServer } = require('../src/server');

  const service = createServer();
  const servicePort = await listen(service);
  t.after(() => close(service));

  const body = JSON.stringify({
    event_id: 'evt_concurrent_001',
    type: 'message.received',
    occurred_at: '2026-09-13T22:00:00Z',
    data: {
      message_id: 'msg_concurrent_001',
      channel: 'email',
      customer: {
        id: 'cus_concurrent_001',
        plan: 'pro',
      },
      subject: 'Cannot log in',
      body: 'I cannot log in to my account.',
      locale: 'en',
    },
  });

  const signature =
    'sha256=' +
    crypto
      .createHmac(
        'sha256',
        process.env.WEBHOOK_SECRET,
      )
      .update(body)
      .digest('hex');

  const responses = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      fetch(
        `http://127.0.0.1:${servicePort}/webhooks/inbox`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-inbox-delivery': `delivery-${index}`,
            'x-inbox-signature': signature,
          },
          body,
        },
      ),
    ),
  );

  const statuses = responses.map((response) => response.status);

  await Promise.all(
    responses.map((response) => response.json()),
  );

  assert.equal(
    statuses.filter((status) => status === 202).length,
    1,
  );

  assert.equal(
    statuses.filter((status) => status === 200).length,
    19,
  );

  await waitFor(() => ticketRequests.length === 1);
  await delay(50);

  assert.equal(ticketRequests.length, 1);
  assert.equal(
    ticketRequests[0].payload.external_ref,
    'evt_concurrent_001',
  );
  assert.equal(
    ticketRequests[0].idempotencyKey,
    'inbox-event:evt_concurrent_001',
  );

  const metricsResponse = await fetch(
    `http://127.0.0.1:${servicePort}/admin/metrics`,
  );
  const metrics = await metricsResponse.json();

  assert.equal(metrics.received, 20);
  assert.equal(metrics.duplicates_ignored, 19);
  assert.equal(metrics.triaged, 1);
  assert.equal(metrics.tickets_created, 1);
});