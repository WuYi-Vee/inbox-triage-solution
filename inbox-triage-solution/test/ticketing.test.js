'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isRetryable,
  retryDelay,
  createTicketWithRetry,
} = require('../src/ticketing');

function error(properties = {}) {
  return Object.assign(new Error('test error'), properties);
}

test('classifies retryable and non-retryable errors', () => {
  assert.equal(isRetryable(error({ code: 'TIMEOUT' })), true);
  assert.equal(isRetryable(new TypeError('fetch failed')), true);
  assert.equal(isRetryable(error({ status: 429 })), true);
  assert.equal(isRetryable(error({ status: 500 })), true);
  assert.equal(isRetryable(error({ status: 503 })), true);

  assert.equal(isRetryable(error({ status: 400 })), false);
  assert.equal(isRetryable(error({ status: 401 })), false);
  assert.equal(isRetryable(error({ status: 422 })), false);
});

test('uses Retry-After and capped exponential backoff', () => {
  const rateLimit = error({
    status: 429,
    retryAfter: '3',
  });

  assert.equal(retryDelay(rateLimit, 1, () => 0), 3000);

  const serverError = error({ status: 503 });

  assert.equal(retryDelay(serverError, 1, () => 0), 125);
  assert.equal(retryDelay(serverError, 2, () => 0), 250);
  assert.equal(retryDelay(serverError, 3, () => 0), 500);
  assert.equal(retryDelay(serverError, 4, () => 0), 1000);
  assert.equal(retryDelay(serverError, 5, () => 0), 1000);
});

test('retries transient errors and records attempt history', async () => {
  let calls = 0;
  const waits = [];

  const sendTicket = async () => {
    calls += 1;

    if (calls < 3) {
      throw error({ status: 503 });
    }

    return {
      ticket: {
        ticket_id: 'tic_test_001',
      },
      status: 201,
      replayed: false,
    };
  };

  const wait = async (delay) => {
    waits.push(delay);
  };

  const result = await createTicketWithRetry(
    { external_ref: 'evt_test_001' },
    sendTicket,
    wait,
  );

  assert.equal(calls, 3);
  assert.equal(result.attempts, 3);
  assert.equal(result.history.length, 3);
  assert.deepEqual(
    result.history.map((entry) => entry.status),
    [503, 503, 201],
  );

  assert.equal(waits.length, 2);
  assert.ok(waits[0] >= 125 && waits[0] <= 250);
  assert.ok(waits[1] >= 250 && waits[1] <= 500);
});

test('does not retry a non-retryable error', async () => {
  let calls = 0;
  const waits = [];

  const sendTicket = async () => {
    calls += 1;
    throw error({ status: 422 });
  };

  const wait = async (delay) => {
    waits.push(delay);
  };

  await assert.rejects(
    () =>
      createTicketWithRetry(
        { external_ref: 'evt_test_002' },
        sendTicket,
        wait,
      ),
    (err) => {
      assert.equal(err.status, 422);
      assert.equal(err.attempts, 1);
      assert.equal(err.history.length, 1);
      assert.equal(err.history[0].retryable, false);
      return true;
    },
  );

  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});