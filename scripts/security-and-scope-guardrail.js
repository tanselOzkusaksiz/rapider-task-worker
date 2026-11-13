#!/usr/bin/env node

/**
 * security-and-scope-guardrail.js
 *
 * Deterministic pre-execution security guardrail, Workspace relevance heuristic,
 * sensitive-field redactor, and outbound public-reply confidentiality validator
 * for ISOLATED-TASK-WORKER (conforming to AGENTS.md Sections 2, 4, 5 & 7).
 */

const HOSTILE_OR_ESCAPE_PATTERNS = [
  { pattern: /rm\s+-rf\s+\//i, reason: 'Destructive host shell command (rm -rf /)' },
  { pattern: /(?:curl|wget)\s+[^|\n]+\|\s*(?:ba)?sh/i, reason: 'Remote shell pipe execution' },
  { pattern: /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions|rules|guardrails)/i, reason: 'Prompt injection / instruction override attempt' },
  { pattern: /(?:reveal|print|dump|show|output)\s+(?:your\s+)?(?:system\s+prompt|developer\s+prompt|api\s+keys?|env(?:ironment)?\s+variables?|\.server\.env|\.env)/i, reason: 'System prompt or secret exfiltration attempt' },
  { pattern: /(?:cat|less|head|tail)\s+[^\n]*(?:\.env|\.server\.env|id_rsa|\/etc\/passwd|\/etc\/shadow)/i, reason: 'Host credential or OS file read attempt' },
  { pattern: /drop\s+(?:database|collection|table)\b/i, reason: 'Destructive database drop statement' },
  { pattern: /(?:modify|edit|patch|commit\s+to|delete)\s+[^\n]*(?:rapider-server|rappider-server|rapider-ui|rapider-app-harness|rapider-ai-rules)/i, reason: 'Attempt to modify protected platform monorepo modules' },
];

const OBVIOUSLY_OFF_WORKSPACE_PATTERNS = [
  { pattern: /^\s*(?:write\s+(?:me\s+)?a\s+(?:poem|song|novel|short\s+story|haiku)|tell\s+me\s+a\s+joke)\b/i, reason: 'Creative entertainment request unrelated to Workspace data or applications' },
  { pattern: /\b(?:solve\s+my\s+leetcode|homework\s+assignment|bitcoin\s+price\s+prediction|astrology\s+horoscope)\b/i, reason: 'General off-topic request unrelated to Workspace data or applications' },
];

const OUTBOUND_CONFIDENTIALITY_VIOLATIONS = [
  { pattern: /\/Users\/[A-Za-z0-9._-]+/i, reason: 'Leaks local host filesystem path (/Users/...)' },
  { pattern: /\bWORKSPACES\/[0-9a-f-]{8,}/i, reason: 'Leaks internal worker directory path (WORKSPACES/...)' },
  { pattern: /\b_process-logs\/|\b_artifacts\//i, reason: 'Leaks internal worker scratch/log path' },
  { pattern: /\bISOLATED-TASK-WORKER\b|\bfetch-and-validate-tasks\.js\b|\bpatch-workitem-task\.js\b|\bmanage-workspace-repos\.js\b/i, reason: 'Exposes internal task worker mechanics or script names' },
  { pattern: /\b(?:gemini-\d|gpt-4|gpt-5|claude-3|claude-sonnet|claude-opus|langgraph)\b/i, reason: 'Exposes underlying AI model or internal orchestration spec' },
  { pattern: /\bBearer\s+eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/i, reason: 'Contains raw JWT Bearer token' },
  { pattern: /\b(?:SPACES_SECRET|AWS_SECRET_ACCESS_KEY|RAPIDER_WORKER_PASSWORD)\s*=\s*\S+/i, reason: 'Contains raw secret assignment' },
];

const SENSITIVE_OBJECT_KEYS = /^(password|secret|clientSecret|accessToken|refreshToken|authenticationToken|apiKey|privateKey|connectionString|authorization|cookie|spacesSecret|awsSecretAccessKey)$/i;

/**
 * Validates raw task content (title, bodyMarkdown, exactUserRequest, events)
 * against hostile prompt-injection, shell-escape, and protected-module patterns.
 *
 * @param {string} combinedText Combined text of the WorkItem and its replies
 * @returns {{ safe: boolean, flags: string[], reason?: string }}
 */
function validateTaskSecurity(combinedText) {
  if (!combinedText || !String(combinedText).trim()) {
    return { safe: false, flags: ['Empty task description'], reason: 'Task contains no actionable request text.' };
  }

  const text = String(combinedText);
  const flags = [];

  for (const rule of HOSTILE_OR_ESCAPE_PATTERNS) {
    if (rule.pattern.test(text)) {
      flags.push(rule.reason);
    }
  }

  if (flags.length > 0) {
    return {
      safe: false,
      flags,
      reason: flags.join('; '),
    };
  }

  return { safe: true, flags: [] };
}

/**
 * Evaluates whether a task appears related to Workspace data, models, templates,
 * files, reporting, or allowed APIs. Flags blatant non-workspace requests early;
 * deeper model-grounded verification is completed by ISOLATED-TASK-WORKER in Step 2
 * after reading WORKSPACES/<projectId>/WORKSPACE_CONTEXT.md.
 *
 * @param {string} combinedText Combined request text
 * @param {{ modelNames?: string[], tableNames?: string[], appNames?: string[] }} [workspaceMeta]
 * @returns {{ relatedCandidate: boolean, reason?: string, matchedDomainSignals: string[] }}
 */
function evaluateWorkspaceRelevanceHeuristic(combinedText, workspaceMeta = {}) {
  const text = String(combinedText || '').trim();
  if (!text) {
    return {
      relatedCandidate: false,
      reason: 'Empty request text.',
      matchedDomainSignals: [],
    };
  }

  for (const offRule of OBVIOUSLY_OFF_WORKSPACE_PATTERNS) {
    if (offRule.pattern.test(text)) {
      return {
        relatedCandidate: false,
        reason: offRule.reason,
        matchedDomainSignals: [],
      };
    }
  }

  const matchedDomainSignals = [];
  const lower = text.toLowerCase();

  const genericWorkspaceSignals = [
    'report', 'csv', 'pdf', 'markdown', 'export', 'table', 'record', 'data',
    'template', 'handlebars', 'email', 'invoice', 'account', 'contact', 'lead',
    'opportunity', 'deal', 'pipeline', 'income', 'revenue', 'forecast', 'summary',
    'file', 'payload', 'api', 'sync', 'audit', 'list', 'calculate', 'monthly',
    'workspace', 'project', 'customer', 'order', 'employee', 'ticket', 'issue',
  ];

  for (const kw of genericWorkspaceSignals) {
    if (lower.includes(kw)) matchedDomainSignals.push(kw);
  }

  const entityTerms = [
    ...(workspaceMeta.modelNames || []),
    ...(workspaceMeta.tableNames || []),
    ...(workspaceMeta.appNames || []),
  ];
  for (const term of entityTerms) {
    if (term && lower.includes(String(term).toLowerCase())) {
      matchedDomainSignals.push(`entity:${term}`);
    }
  }

  return {
    relatedCandidate: true,
    matchedDomainSignals: Array.from(new Set(matchedDomainSignals)),
  };
}

/**
 * Enforces AGENTS.md Section 7 (Public Task Replies & Communication Confidentiality Standard).
 * Blocks outbound WorkItem replies/outcomes if they leak host paths, internal worker mechanics,
 * AI model names, or credentials.
 *
 * @param {string} publicText Outbound Markdown reply, outcome, or recommendation text
 * @returns {{ valid: boolean, violations: string[] }}
 */
function validatePublicReplyConfidentiality(publicText) {
  const text = String(publicText || '');
  const violations = [];

  for (const check of OUTBOUND_CONFIDENTIALITY_VIOLATIONS) {
    if (check.pattern.test(text)) {
      violations.push(check.reason);
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

/**
 * Deeply clones JSON-serializable metadata while stripping credentials, secrets,
 * auth headers, and tokens before writing any Workspace snapshot file to disk.
 *
 * @param {any} input Arbitrary API object or array
 * @returns {any} Sanitized structure safe for local Workspace repo snapshot
 */
function redactSensitiveFields(input) {
  if (input === null || input === undefined) return input;
  if (Array.isArray(input)) {
    return input.map((item) => redactSensitiveFields(item));
  }
  if (typeof input === 'object') {
    const clean = {};
    for (const [key, value] of Object.entries(input)) {
      if (SENSITIVE_OBJECT_KEYS.test(key)) {
        clean[key] = '[REDACTED]';
      } else {
        clean[key] = redactSensitiveFields(value);
      }
    }
    return clean;
  }
  return input;
}

/**
 * Standardized polite refusal message for tasks rejected by Step 2 Guardrail.
 */
const DEFAULT_SCOPE_REJECTION_REPLY =
  'This task could not be processed because Task Worker only handles requests directly related to your Workspace data, models, templates, files, and authorized Workspace applications.';

module.exports = {
  validateTaskSecurity,
  evaluateWorkspaceRelevanceHeuristic,
  validatePublicReplyConfidentiality,
  redactSensitiveFields,
  DEFAULT_SCOPE_REJECTION_REPLY,
};

