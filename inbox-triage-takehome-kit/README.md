# Inbox Triage take-home — starter kit

Everything you need to run the exercise locally. The full specification is in the
PDF brief you received; this README only covers the tooling.

Requires **Node 18+** (for the kit itself). Your solution can be TypeScript/Node 20+
(preferred) or Python 3.11+.

## What is in here

| Path | What it is |
|------|------------|
| `downstream/server.js` | Mock of our ticketing API. Deliberately flaky: random 5xx, `429 + Retry-After`, and requests that create the ticket and then hang. Honours `Idempotency-Key`. |
| `replay/replay.js` | Fires a realistic stream of webhook deliveries at your service (bursts, concurrent and delayed duplicates, bad signature, malformed body, unknown event types), behaves like the real provider (retries anything that is not acknowledged with 2xx within 5 s), then checks the ticketing mock and prints `PASS` / `FAIL`. |
| `replay/events.json` | The fixture the replay uses. Read it. |
| `.env.example` | Every environment variable used on both sides. |

## Running it

```bash
cp .env.example .env

# terminal 1 — mock ticketing API on :4000
npm run downstream

# terminal 2 — your service on :3000, using the mock LLM
LLM_PROVIDER=mock <your start command>

# terminal 3 — replay ~45 deliveries, wait for the pipeline to drain, verify
npm run replay
```

Target: **24 tickets, 0 duplicates, `RESULT: PASS`**.

Useful variations:

```bash
npm run downstream:stable   # no failure injection — get the happy path working first
SEED=42 npm run downstream  # deterministic failure injection, useful when debugging
npm run replay:reset        # wipe the mock downstream first (restart your service too,
                            # otherwise every event looks like a duplicate to it)
npm run replay:quiet        # less output
```

Run the replay twice in a row without resetting anything: the total must still be
24 tickets. Every event in the second run is a redelivery of something you have
already processed.

## Mock ticketing API — quick reference

```
POST   /tickets          Idempotency-Key header honoured (see brief)
GET    /tickets          list tickets
GET    /tickets/:id
GET    /stats            counters, incl. duplicate_tickets (tickets sharing an external_ref)
DELETE /tickets          reset (tests)
GET    /health
```

Responses from `POST /tickets`: `201` created · `200` idempotent replay
(`Idempotent-Replayed: true`) · `400` validation error · `422` idempotency key reused
with a different payload · `429` with `Retry-After` · `500`/`503` transient · and some
requests hang for 15 s **after** the ticket has been created.

Do not modify the kit; if you think something in it is wrong, say so in your README.
