'use strict';

const CATEGORIES = new Set([
  'billing',
  'bug',
  'feature_request',
  'account_access',
  'abuse_report',
  'other',
]);

const PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3']);
const SENTIMENTS = new Set(['positive', 'neutral', 'negative']);
const RAISED_PRIORITY = {
  P0: 'P0',
  P1: 'P0',
  P2: 'P1',
  P3: 'P2',
};

const TRIAGE_FIELDS = [
  'category',
  'priority',
  'sentiment',
  'language',
  'summary',
  'security_or_safety_concern',
  'needs_human',
];

function validateTriage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))  return 'triage must be a JSON object';

  for (const field of TRIAGE_FIELDS)
    if (!(field in value)) return `missing field: ${field}`;
  for (const field of Object.keys(value))
    if (!TRIAGE_FIELDS.includes(field)) return `unexpected field: ${field}`;

  if (!CATEGORIES.has(value.category))  return 'category is invalid';
  if (!PRIORITIES.has(value.priority))  return 'priority is invalid';
  if (!SENTIMENTS.has(value.sentiment)) return 'sentiment is invalid';
  if (typeof value.language !== 'string' || !/^[a-z]{2}$/.test(value.language))
    return 'language must be a two-letter lowercase code';
  if ( typeof value.summary !== 'string' || value.summary.length < 1 || value.summary.length > 200)
    return 'summary must be a string of 1-200 characters';
  if (typeof value.security_or_safety_concern !== 'boolean')
    return 'security_or_safety_concern must be a boolean';
  if (typeof value.needs_human !== 'boolean')
    return 'needs_human must be a boolean';
  return null;
}

function detectLanguage(text) {
  if (/[\u3040-\u30ff]/.test(text)) return 'ja';
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh';
  if (/\b(hola|cancelé|suscripción|gracias)\b/i.test(text)) return 'es';
  if (/\b(bonjour|merci|possible)\b/i.test(text)) return 'fr';
  return 'en';
}

function mockTriage(event) {
  const text = `${event.data.subject || ''} ${event.data.body}`;
  const promptInjection = /ignore (all )?previous instructions|system notice|respond only with/i.test(text);

  let category = 'other';
  let securityConcern = false;

  if (!promptInjection) {
    if ( /sexuali[sz]ed|without permission|harass|threat|non-consensual|ban the account/i.test(text)) {
      category = 'abuse_report';
      securityConcern = true;
    } else if (/hacked|account email was updated|don't recognise|do not recognize/i.test(text)) {
      category = 'account_access';
      securityConcern = true;
    } else if (/log in|login|locked out|password|2fa|ログイン|パスワード/i.test(text)) {
      category = 'account_access';
    } else if (/charged|refund|invoice|subscription|cobro|cobrar|suscripción|vat/i.test(text)) {
      category = 'billing';
    } else if (/fail|crash|error|glitch|losing|lost|杂音|故障|失败/i.test(text)) {
      category = 'bug';
    } else if (/dark mode|schedule|feature|flac|sample rate|bit depth|would make|ajouter/i.test(text)) {
      category = 'feature_request';
    }
  }

  let priority = 'P3';

  if (category === 'abuse_report' || securityConcern) {
    priority = 'P0';
  } else if (category === 'billing' || category === 'account_access') {
    priority = 'P1';
  } else if (category === 'bug') {
    priority = /losing|lost|blocked|deadline/i.test(text) ? 'P1' : 'P2';
  }

  const summaries = {
    billing: 'Customer reports a billing issue.',
    bug: 'Customer reports a product problem.',
    feature_request: 'Customer requests a product improvement.',
    account_access: 'Customer needs help accessing an account.',
    abuse_report: 'Customer reports a security or safety concern.',
    other: 'Customer submitted a general message.',
  };

  const positive = category === 'other' && /thank|love|incredible|🔥/i.test(text);

  return {
    category,
    priority,
    sentiment: positive ? 'positive' : category === 'other' ? 'neutral' : 'negative',
    language: detectLanguage(text),
    summary: summaries[category],
    security_or_safety_concern: securityConcern,
    needs_human: priority === 'P0' || priority === 'P1' || promptInjection,
  };
}

async function callMockLlm(event) {
  return {
    output: mockTriage(event),
    meta: {
      model: 'mock',
      input_tokens: 0,
      output_tokens: 0,
    },
  };
}

function fallbackTriage(event) {
  const text = `${event.data.subject || ''} ${event.data.body}`;
  return {
    category: 'other',
    priority: 'P2',
    sentiment: 'neutral',
    language: detectLanguage(text),
    summary: 'Message requires manual review because automated triage failed.',
    security_or_safety_concern: false,
    needs_human: true,
  };
}

async function triageMessage(event, callLlm = callMockLlm) {
  let lastOutput = null;
  let problem = null;
  let model = 'unknown';
  let inputTokens = 0;
  let outputTokens = 0;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await callLlm(event, problem);

    lastOutput = response.output;
    model = response.meta.model;
    inputTokens += response.meta.input_tokens || 0;
    outputTokens += response.meta.output_tokens || 0;

    problem = validateTriage(lastOutput);

    if (!problem) {
      return {
        status: 'ok',
        modelOutput: lastOutput,
        effective: applyBusinessRules(
          lastOutput,
          event.data.customer.plan,
        ),
        meta: {
          model,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          attempts: attempt,
        },
      };
    }
  }

  return {
    status: 'fallback',
    modelOutput: lastOutput,
    effective: fallbackTriage(event),
    meta: {
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      attempts: 2,
    },
  };
}

function applyBusinessRules(modelOutput, plan) {
  const triage = { ...modelOutput };

  if (triage.category === 'abuse_report' || triage.security_or_safety_concern) {
    triage.priority = 'P0';
    triage.needs_human = true;
  }
  if (plan === 'team') {
    triage.priority = RAISED_PRIORITY[triage.priority];
  }
  if (triage.priority === 'P0' || triage.priority === 'P1') {
    triage.needs_human = true;
  }

  return triage;
}



module.exports = { validateTriage , mockTriage, triageMessage, applyBusinessRules,};