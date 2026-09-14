## Architecture

The solution is organized around an asynchronous webhook-processing pipeline.

```text
Inbox provider
      |
      | POST /webhooks/inbox
      v
Signature verification and event validation
      |
      | deduplicate by event_id
      | enqueue and return 202
      v
In-process FIFO worker
      |
      v
LLM triage and schema validation
      |
      | enforce business rules R1-R3
      v
Stable ticket payload
      |
      | Idempotency-Key: inbox-event:<event_id>
      v
Ticketing API
      |
      +----> completed
      |
      +----> bounded retries ----> dead-letter queue
```

### HTTP layer

`src/server.js` owns the HTTP server and the lifecycle of each event. It verifies the HMAC signature against the exact raw request bytes before parsing the body, validates the event envelope, acknowledges unknown event types, and deduplicates valid messages using `event_id`.

A newly accepted event is stored and added to an in-process FIFO queue. The webhook returns `202` before triage or ticket creation begins, keeping the response path within the provider's five-second acknowledgement window.

The same module exposes the health, metrics, and dead-letter administration endpoints. A downstream dead-letter retry places the event back on the queue while preserving its successful triage result and previously constructed ticket payload.

### Triage layer

`src/triage.js` contains the model-call boundary, deterministic mock implementation, output validation, fallback behavior, and business rules.

The model result must match the required triage shape exactly. Missing fields, additional fields, invalid enums, invalid language codes, incorrect boolean values, and summaries outside the permitted length are rejected. Invalid output receives one corrective attempt. If the second attempt also fails, the service creates a conservative fallback ticket with `category: "other"`, `priority: "P2"`, and `needs_human: true`.

After validation, rules R1-R3 are enforced in application code rather than relying on model instructions. The original validated model output and model metadata are retained separately from the effective triage result used to create the ticket.

### Ticketing layer

`src/ticketing.js` constructs the downstream payload and performs ticket creation requests. The payload is constructed once per event and cached so every retry sends the same data.

Each downstream request uses a stable idempotency key derived from `event_id`:

```text
inbox-event:<event_id>
```

This prevents duplicate tickets when a downstream request creates the ticket but the response is lost or exceeds the client timeout.

The client classifies connection failures, timeouts, HTTP 429, and HTTP 5xx responses as retryable. It applies capped exponential backoff with equal jitter, respects numeric `Retry-After` values, and stops after six attempts. HTTP 400, 401, and 422 responses are treated as non-retryable.

If ticket creation ultimately fails, the event is moved to the dead-letter queue with the failure stage, reason, and complete attempt history.

### State and deployment boundary

Event records, deduplication state, the work queue, dead letters, and metrics are currently stored in memory. This keeps the take-home implementation small and makes its reliability mechanics easy to inspect.

The main production boundary is the in-process queue and Maps. A production deployment would replace them with a durable shared queue and a transactional event store with a unique constraint on `event_id`. This would support safe recovery after restarts, concurrent workers, and multiple service instances behind a load balancer.



## How to run and test

Requirements: Node.js 20 or newer. The solution and starter-kit directories should be next to each other.


### 1. Start the mock ticketing API

In terminal 1:

```bash
cd ../inbox-triage-takehome-kit
SEED=42 npm run downstream
```

The downstream API starts at `http://localhost:4000`.

For a failure-free happy-path run, use `npm run downstream:stable` instead.

### 2. Start the inbox triage service

In terminal 2:

```bash
cd ../inbox-triage-solution

PORT=3000 \
WEBHOOK_SECRET=whsec_test_do_not_use_in_prod \
DOWNSTREAM_URL=http://localhost:4000 \
LLM_PROVIDER=mock \
npm start
```

Verify that the service is running:

```bash
curl http://localhost:3000/health
```

Expected response:

```json
{"ok":true}
```

### 3. Run the automated tests

From `inbox-triage-solution`:

```bash
npm test
```

The tests cover triage validation and fallback, business rules, downstream retry behavior, backoff, and concurrent duplicate deliveries.

### 4. Run the full replay

Start with a fresh triage-service process, then run the following from the starter kit in terminal 3:

```bash
cd ../inbox-triage-takehome-kit

WEBHOOK_SECRET=whsec_test_do_not_use_in_prod \
WEBHOOK_URL=http://localhost:3000/webhooks/inbox \
SETTLE_SECONDS=45 \
npm run replay:reset
```

Expected result:

```text
24 tickets
0 duplicate tickets
RESULT: PASS
```

To verify idempotency across delayed redelivery, run the replay again without resetting or restarting either service:

```bash
npm run replay
```

The result should still be 24 tickets, 0 duplicates, and `RESULT: PASS`.

## Scaling limits

### At 100× the current volume

At 100× the expected load, the first component to fail would be the single sequential worker. The current design processes one queued event at a time, so a five-second downstream timeout blocks every event behind it. At approximately 200,000 messages per day and release bursts of roughly 5,000 messages per minute, events would arrive faster than the worker could process them. The in-memory queue would continue growing, increasing latency and memory usage until the process became unstable or crashed. Because the webhook has already acknowledged those events, a crash would also lose queued work.

### With two instances behind a load balancer

The first correctness problem with two instances is that deduplication state is local to each process. Concurrent deliveries duplicate deliveries of the same `event_id` can be routed to different instances, and both instances can pass their independent `events.has()` checks. They may then both run triage and attempt ticket creation.

The downstream idempotency key still prevents two tickets when both instances produce the same payload. However, a real LLM may produce different triage results for the same event. Reusing the same idempotency key with different payloads would cause one request to succeed and the other to receive a `422` conflict. The two instances would also have separate queues, DLQs, and metrics, so an administrator could not obtain a complete view from either instance.

## Decisions and Trade off

1. rapid confirmation and reliable processing

   I chose to acknowledge valid webhooks quickly and perform LLM triage and ticket creation asynchronously. The request path only verifies the raw-body signature, parses and validates the event, checks for duplicates, and enqueues the work before returning a 2xx response. This keeps the response well within the provider’s five-second deadline, even when the LLM or downstream API is slow. The trade-off is that the current queue is in memory: if the process crashes after acknowledging the webhook but before completing the work, the event may be lost. In production, I would place the event in a durable queue or database before acknowledging it.

2. local deduplication with downstream idempotency

   I chose to combine local deduplication with downstream idempotency because they protect against different failure modes. The local event map prevents concurrent or delayed deliveries with the same event_id from running through the pipeline more than once within a single process. The downstream Idempotency-Key, also derived from event_id, handles ambiguous outcomes such as a request that creates a ticket but times out before the service receives the response. The trade-off is that the local map does not survive restarts and cannot coordinate multiple service instances. A production implementation would use shared persistent state with a unique constraint on event_id, while retaining downstream idempotency as a final safeguard.

3. not to rerun the LLM

   I chose not to rerun the LLM when retrying a failed downstream operation. Once triage succeeds, the service stores both the validated triage result and the final ticket payload, and every downstream retry reuses them. This avoids additional cost and latency, and prevents a nondeterministic LLM from producing a different payload for the same idempotency key, which could cause a 422 conflict. The trade-off is that intermediate results must be stored, and an event already waiting for retry will not automatically adopt later prompt or business-rule changes. The current implementation stores this state in memory; a production version would persist it together with appropriate model and rule version information.





## With one more day

I would prioritize:

1. Complete and test the real LLM provider adapter, including timeout and retries for 429, 5xx, and network failures.
2. Persist event state and move work to a durable shared queue.
3. Add an automated end-to-end test command that starts and cleans up both services.



## Time and assistance

Time spent: approximately 8 hours of focused work.

I used Codex as a coding assistant to review the starter kit, discuss design choices, and help draft implementation and test steps. I entered and ran the code myself and reviewed the resulting behavior.