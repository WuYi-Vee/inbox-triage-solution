'use strict';

const DOWNSTREAM_URL = ( process.env.DOWNSTREAM_URL || 'http://localhost:4000').replace(/\/$/, '');
const REQUEST_TIMEOUT_MS = 5000;
const MAX_ATTEMPTS = 6;
const BASE_DELAY_MS = 250;
const MAX_DELAY_MS = 2000;

function buildTicketPayload(event, triage) {
  const result = triage.effective;

  return {
    external_ref: event.event_id,
    customer_id: event.data.customer.id,
    channel: event.data.channel,
    category: result.category,
    priority: result.priority,
    summary: result.summary,
    needs_human: result.needs_human,
    triage: {
      status: triage.status,
      model_output: triage.modelOutput,
      meta: triage.meta,
    },
    source: {
      message_id: event.data.message_id,
      subject: event.data.subject,
      body: event.data.body,
      locale: event.data.locale,
      occurred_at: event.occurred_at,
      plan: event.data.customer.plan,
    },
  };
}

async function createTicket(payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${DOWNSTREAM_URL}/tickets`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `inbox-event:${payload.external_ref}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const body = await response.json();

    if (response.status === 200 || response.status === 201) {
      return {
        ticket: body,
        status: response.status,
        replayed:
          response.headers.get('idempotent-replayed') === 'true',
      };
    }
    const error = new Error(`downstream returned ${response.status}`);
    error.status = response.status;
    error.retryAfter = response.headers.get('retry-after');
    throw error;
  } catch (err) {
    if (err.name === 'AbortError') {
      const timeoutError = new Error('downstream timeout');
      timeoutError.code = 'TIMEOUT';
      throw timeoutError;
    }

    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryable(err) {
  if (err.code === 'TIMEOUT') return true;
  if (err instanceof TypeError) return true;
  if (err.status === 429) return true;
  if (err.status >= 500 && err.status <= 599) return true;
  return false;
}

function retryDelay(err, attempt, random = Math.random) {
  if (err.status === 429) {
    const seconds = Number(err.retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
  }

  const maximum = Math.min(
    BASE_DELAY_MS * 2 ** (attempt - 1),
    MAX_DELAY_MS,
  );

  return maximum / 2 + random() * maximum / 2;
}

async function createTicketWithRetry( payload, sendTicket = createTicket, wait = sleep ) {
  const history = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await sendTicket(payload);

      history.push({ attempt, status: result.status });

      return {
        ...result,
        attempts: attempt,
        history,
      };
    } catch (err) {
      const retryable = isRetryable(err);

      const entry = { attempt, status: err.status || null, code: err.code || null, error: err.message, retryable};
      history.push(entry);

      if (!retryable || attempt === MAX_ATTEMPTS) {
        err.attempts = attempt;
        err.history = history;
        throw err;
      }

      const delay = retryDelay(err, attempt);
      entry.delay_ms = Math.round(delay);
      await wait(delay);
    }
  }
}

module.exports = { buildTicketPayload , createTicket, isRetryable, retryDelay, createTicketWithRetry};