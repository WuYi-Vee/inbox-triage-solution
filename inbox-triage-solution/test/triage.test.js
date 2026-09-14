'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateTriage,
  triageMessage,
  applyBusinessRules,
} = require('../src/triage');

const validTriage = {
  category: 'bug',
  priority: 'P2',
  sentiment: 'negative',
  language: 'en',
  summary: 'Customer reports a product problem.',
  security_or_safety_concern: false,
  needs_human: false,
};

const event = {
  data: {
    subject: 'Login problem',
    body: 'I cannot log in.',
    customer: {
      plan: 'pro',
    },
  },
};

test('validates the exact triage schema', () => {
  assert.equal(validateTriage(validTriage), null);

  assert.equal(
    validateTriage({ ...validTriage, extra: true }),
    'unexpected field: extra',
  );

  assert.equal(
    validateTriage({ ...validTriage, summary: 'x'.repeat(201) }),
    'summary must be a string of 1-200 characters',
  );
});

test('retries invalid model output once and then falls back', async () => {
  const corrections = [];

  const invalidLlm = async (_event, correction) => {
    corrections.push(correction);

    return {
      output: {
        ...validTriage,
        priority: 'urgent',
      },
      meta: {
        model: 'mock-invalid',
        input_tokens: 3,
        output_tokens: 2,
      },
    };
  };

  const result = await triageMessage(event, invalidLlm);

  assert.equal(corrections.length, 2);
  assert.equal(corrections[0], null);
  assert.equal(corrections[1], 'priority is invalid');

  assert.equal(result.status, 'fallback');
  assert.equal(result.effective.category, 'other');
  assert.equal(result.effective.priority, 'P2');
  assert.equal(result.effective.needs_human, true);

  assert.equal(result.meta.attempts, 2);
  assert.equal(result.meta.input_tokens, 6);
  assert.equal(result.meta.output_tokens, 4);
});

test('R1 makes abuse and safety concerns P0 with human review', () => {
  const cases = [
    { category: 'abuse_report' },
    { security_or_safety_concern: true },
  ];

  for (const change of cases) {
    const result = applyBusinessRules(
      {
        ...validTriage,
        ...change,
        priority: 'P3',
        needs_human: false,
      },
      'free',
    );

    assert.equal(result.priority, 'P0');
    assert.equal(result.needs_human, true);
  }
});

test('R2 raises team priority by one level', () => {
  const result = applyBusinessRules(
    {
      ...validTriage,
      priority: 'P3',
    },
    'team',
  );

  assert.equal(result.priority, 'P2');
});

test('R3 requires human review for P0 and P1', () => {
  for (const priority of ['P0', 'P1']) {
    const result = applyBusinessRules(
      {
        ...validTriage,
        priority,
        needs_human: false,
      },
      'free',
    );

    assert.equal(result.priority, priority);
    assert.equal(result.needs_human, true);
  }
});