import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const LIGHTHOUSE_LABEL = 'lighthouse';
export const LIGHTHOUSE_TEST_LABEL = 'lighthouse-test';
export const REAL_FINDING_MARKER = 'lighthouse-finding';
export const TEST_FINDING_MARKER = 'lighthouse-test-finding';
export const FINDINGS_BLOCK_MARKER = '<!-- lighthouse-findings -->';
export const FINGERPRINT_VERSION = 'lh1';
export const MAX_NEW_ISSUES = 3;
export const MAX_TITLE_SIMILARITY = 0.8;

export const CATEGORIES = [
  'performance',
  'accessibility',
  'seo',
  'best-practices',
];
export const SEVERITIES = ['critical', 'high', 'medium', 'low'];

const CATEGORY_LABELS = {
  performance: 'performance',
  accessibility: 'accessibility',
  seo: 'seo',
  'best-practices': 'best-practices',
};

const HASHED_FILENAME = /-[A-Za-z0-9_-]{8,}(?=\.[A-Za-z0-9]+$)/;
const POSITIONAL_PSEUDO =
  /:(?:nth-child|nth-of-type|nth-last-child|nth-last-of-type)\([^)]*\)/g;
const FINDINGS_BLOCK =
  /<!--\s*lighthouse-findings\s*-->\s*```json\s*([\s\S]*?)```/;
const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'with',
]);

/**
 * Normalises a resource reference so that a new content hash does not produce a
 * new fingerprint: `/assets/index-C519h91O.js` becomes `/assets/index-<hash>.js`.
 */
export function normaliseResource(value) {
  let path = String(value ?? '').trim();
  if (!path) return '/';
  try {
    path = new URL(path).pathname;
  } catch {
    // Relative resource paths are already what we want.
  }
  path = path.split('#')[0].split('?')[0];
  path = path.replace(HASHED_FILENAME, '-<hash>');
  return path || '/';
}

/** Normalises a DOM selector by dropping positional pseudo-classes and spacing. */
export function normaliseSelector(value) {
  return String(value ?? '')
    .trim()
    .replace(POSITIONAL_PSEUDO, '')
    .replace(/\s*>\s*/g, '>')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** Stable scope of a finding: resource, selector, snippet, or the audit itself. */
export function findingScope(finding) {
  if (typeof finding?.scope === 'string' && finding.scope.trim()) {
    return normaliseResource(finding.scope);
  }
  const evidence = finding?.evidence ?? {};
  if (typeof evidence.resource === 'string' && evidence.resource.trim()) {
    return normaliseResource(evidence.resource);
  }
  if (typeof evidence.selector === 'string' && evidence.selector.trim()) {
    return normaliseSelector(evidence.selector);
  }
  if (typeof evidence.snippet === 'string' && evidence.snippet.trim()) {
    return String(evidence.snippet)
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
      .slice(0, 120);
  }
  return 'audit';
}

/**
 * Fingerprint of a finding. Scores, savings and dates are deliberately excluded:
 * the key answers "same problem in the same place", not "same numbers today".
 */
export function fingerprint({ route, audit, scope }) {
  const input = [
    FINGERPRINT_VERSION,
    String(route ?? '/').trim().toLowerCase(),
    String(audit ?? '').trim(),
    String(scope ?? 'audit').trim(),
  ].join('|');
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

export function findingFingerprint(finding) {
  return fingerprint({
    route: finding?.route,
    audit: finding?.audit,
    scope: findingScope(finding),
  });
}

/** The JSON payload stored inside an issue body marker. */
export function markerPayload(finding) {
  return {
    fingerprint: finding.fingerprint ?? findingFingerprint(finding),
    route: finding.route,
    audit: finding.audit,
  };
}

export function buildMarker(finding) {
  return `<!-- ${REAL_FINDING_MARKER}: ${JSON.stringify(markerPayload(finding))} -->`;
}

export function buildTestMarker(finding) {
  return `<!-- ${TEST_FINDING_MARKER}: ${JSON.stringify(markerPayload(finding))} -->`;
}

function parseMarkerList(body, name) {
  const pattern = new RegExp(`<!--\\s*${name}:\\s*([\\s\\S]*?)\\s*-->`, 'g');
  const found = [];
  for (const match of String(body ?? '').matchAll(pattern)) {
    try {
      const payload = JSON.parse(match[1]);
      if (payload && typeof payload.fingerprint === 'string') found.push(payload);
    } catch {
      // A malformed marker is ignored: it cannot identify an existing issue.
    }
  }
  return found;
}

/** Parses both marker families, keeping real and synthetic issues apart. */
export function parseIssueMarkers(body) {
  return {
    real: parseMarkerList(body, REAL_FINDING_MARKER),
    test: parseMarkerList(body, TEST_FINDING_MARKER),
  };
}

export function categoryLabel(category) {
  return CATEGORY_LABELS[category] ?? null;
}

export function realIssueLabels(finding) {
  const labels = [LIGHTHOUSE_LABEL];
  const category = categoryLabel(finding.category);
  if (category) labels.push(category);
  labels.push(finding.severity === 'low' ? 'enhancement' : 'bug');
  return labels;
}

export function testIssueLabels() {
  return [LIGHTHOUSE_TEST_LABEL];
}

export function applyTestTitle(title) {
  const stripped = String(title ?? '')
    .replace(/^(\s*\[TEST\]\s*)+/i, '')
    .trim();
  return `[TEST] ${stripped}`;
}

/** Strict boolean parsing: GitHub job outputs and env vars are strings. */
export function parseBooleanEnv(value, name) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be "true" or "false", got ${JSON.stringify(value)}`);
}

/** Test mode is a manual-run-only feature. */
export function assertTestModeAllowed({ testMode, eventName }) {
  if (testMode && eventName !== 'workflow_dispatch') {
    throw new Error(
      `test_mode is only available for workflow_dispatch, got ${eventName}`,
    );
  }
}

function isRelativePath(path) {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.includes('..') &&
    !path.includes('\\')
  );
}

export function validateFinding(finding) {
  const errors = [];
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
    return ['finding must be an object'];
  }
  if (typeof finding.id !== 'string' || !/^[a-z0-9][a-z0-9-]{2,60}$/.test(finding.id)) {
    errors.push('id must be kebab-case');
  }
  if (typeof finding.route !== 'string' || !finding.route.startsWith('/')) {
    errors.push('route must start with /');
  }
  if (typeof finding.audit !== 'string' || finding.audit.trim() === '') {
    errors.push('audit is required');
  }
  if (!CATEGORIES.includes(finding.category)) {
    errors.push(`category must be one of ${CATEGORIES.join(', ')}`);
  }
  if (!SEVERITIES.includes(finding.severity)) {
    errors.push(`severity must be one of ${SEVERITIES.join(', ')}`);
  }
  if (typeof finding.title !== 'string' || finding.title.trim().length < 10) {
    errors.push('title must describe the fix');
  }
  if (typeof finding.fix !== 'string' || finding.fix.trim().length < 20) {
    errors.push('fix must be concrete');
  }
  if (typeof finding.impact !== 'string' || finding.impact.trim().length < 20) {
    errors.push('impact must explain what improves');
  }
  const evidence = finding.evidence;
  if (!evidence || typeof evidence !== 'object') {
    errors.push('evidence is required');
  } else if (
    typeof evidence.resource !== 'string' &&
    typeof evidence.selector !== 'string' &&
    typeof evidence.snippet !== 'string'
  ) {
    errors.push('evidence needs a resource, selector or snippet');
  }
  const repo = finding.repo_evidence;
  if (!repo || typeof repo !== 'object') {
    errors.push('repo_evidence is required');
  } else {
    if (!isRelativePath(repo.file)) {
      errors.push('repo_evidence.file must be a relative repository path');
    }
    if (typeof repo.symbol !== 'string' || repo.symbol.trim().length < 3) {
      errors.push('repo_evidence.symbol must be at least 3 characters');
    }
  }
  if (finding.synthetic !== undefined && typeof finding.synthetic !== 'boolean') {
    errors.push('synthetic must be a boolean');
  }
  return errors;
}

function defaultFileContains(file, symbol) {
  // A missing path and a directory both throw here; either way the symbol is
  // not evidence, so the finding is rejected instead of aborting the run.
  try {
    return readFileSync(file, 'utf8').includes(symbol);
  } catch {
    return false;
  }
}

function validateScope(finding, scope) {
  if (!scope) return [];
  const errors = [];
  const routes = Array.isArray(scope.routes) ? scope.routes : [];
  if (!routes.includes(finding.route)) {
    errors.push(`route ${JSON.stringify(finding.route)} was not audited`);
  }
  const audits = Array.isArray(scope.audits) ? scope.audits : [];
  if (!audits.includes(finding.audit)) {
    errors.push(`audit ${JSON.stringify(finding.audit)} is not in the digest`);
  }
  return errors;
}

/**
 * Applies the actionability gate: a finding becomes an issue only when it names
 * a real repository file, a symbol that is actually there, and an audit/route
 * from the digest the model was given.
 */
export function reviewFinding(
  finding,
  { mode, scope = null, fileExists = existsSync, fileContains = defaultFileContains } = {},
) {
  const synthetic = finding?.synthetic === true;
  if (mode === 'test' && !synthetic) {
    return { ok: false, reason: 'only the synthetic fixture is published in test mode' };
  }
  if (mode !== 'test' && synthetic) {
    return { ok: false, reason: 'a synthetic finding cannot be published outside test mode' };
  }
  const errors = validateFinding(finding);
  if (errors.length > 0) {
    return { ok: false, reason: errors.join('; ') };
  }
  const scopeErrors = validateScope(finding, scope);
  if (scopeErrors.length > 0) {
    return { ok: false, reason: scopeErrors.join('; ') };
  }
  const { file, symbol } = finding.repo_evidence;
  if (!fileExists(file)) {
    return { ok: false, reason: `repo_evidence.file does not exist: ${file}` };
  }
  if (!fileContains(file, symbol)) {
    return { ok: false, reason: `repo_evidence.symbol is not in ${file}: ${symbol}` };
  }
  return { ok: true, reason: null };
}

/** Extracts the machine-readable findings block from the agent report. */
export function extractFindings(report) {
  const match = FINDINGS_BLOCK.exec(String(report ?? ''));
  if (!match) {
    return {
      findings: [],
      error: `the report has no ${FINDINGS_BLOCK_MARKER} JSON block`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch (error) {
    return { findings: [], error: `invalid findings JSON: ${error.message}` };
  }
  const findings = Array.isArray(parsed) ? parsed : parsed?.findings;
  if (!Array.isArray(findings)) {
    return { findings: [], error: 'findings must be an array' };
  }
  return { findings, error: null };
}

function titleTokens(title) {
  const words = String(title ?? '')
    .toLowerCase()
    .match(/[a-z0-9]+/g);
  return new Set((words ?? []).filter((word) => !STOP_WORDS.has(word)));
}

export function titleSimilarity(left, right) {
  const a = titleTokens(left);
  const b = titleTokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) {
    if (b.has(token)) shared += 1;
  }
  return shared / (a.size + b.size - shared);
}

/**
 * Soft duplicate check used only as a veto for real findings whose issue was
 * created before fingerprints existed. Never creates a new issue by itself.
 */
export function findSoftDuplicate(title, existing, threshold = MAX_TITLE_SIMILARITY) {
  let best = null;
  for (const issue of existing ?? []) {
    // Fingerprinted issues are deduplicated by their marker alone: a similar
    // title must not suppress a different finding.
    if (parseIssueMarkers(issue.body).real.length > 0) continue;
    const score = titleSimilarity(title, issue.title);
    if (score >= threshold && (!best || score > best.score)) {
      best = { issue, score };
    }
  }
  return best;
}

function readStdin() {
  return readFileSync(0, 'utf8');
}

function parseArgs(argv) {
  const args = { mode: 'extract' };
  let rest = argv;
  if (rest[0] && !rest[0].startsWith('--')) {
    args.mode = rest[0];
    rest = rest.slice(1);
  }
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === '--report') args.report = rest[++index];
    else if (value === '--out') args.out = rest[++index];
    else throw new Error(`unknown argument: ${value}`);
  }
  return args;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(2);
  }
  if (args.mode !== 'extract' || !args.out) {
    console.error(
      'usage: node scripts/lighthouse-findings.mjs extract --report <report.md> --out <findings.json>',
    );
    process.exit(2);
  }
  const report = args.report ? readFileSync(args.report, 'utf8') : readStdin();
  const result = extractFindings(report);
  if (result.error) {
    console.error(`::error::${result.error}`);
    process.exit(1);
  }
  const payload = { findings: result.findings };
  if (args.out === '-') {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  writeFileSync(args.out, `${JSON.stringify(payload, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
