import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertTestModeAllowed, parseBooleanEnv } from './lighthouse-findings.mjs';
import { testFinding } from './lighthouse-test-fixture.mjs';

export const MAX_CONTEXT_BYTES = 200_000;
export const MAX_DETAIL_ITEMS = 3;
export const MAX_DETAIL_CHARS = 220;
export const MAX_DESCRIPTION_CHARS = 240;

const SUMMARY_CATEGORIES = [
  'performance',
  'accessibility',
  'seo',
  'best-practices',
];
const METRIC_AUDITS = [
  'first-contentful-paint',
  'largest-contentful-paint',
  'total-blocking-time',
  'cumulative-layout-shift',
  'speed-index',
  'interactive',
];
const NON_FAILING_MODES = new Set(['manual', 'notApplicable', 'informative']);

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function hashFile(path) {
  return sha256(readFileSync(path));
}

export function listReports(reportsDir) {
  return readdirSync(reportsDir)
    .filter((name) => name.endsWith('.report.json') || name.endsWith('.report.html'))
    .sort();
}

export function slugOf(name) {
  return basename(name)
    .replace(/\.report\.(json|html)$/, '')
    .replace(/[^A-Za-z0-9_-]/g, '-');
}

export function readLhr(reportsDir, slug) {
  const path = join(reportsDir, `${slug}.report.json`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Records the exact bytes Lighthouse produced. Written once after the audit and
 * compared before and after digest generation.
 */
export function recordReports({
  reportsDir,
  appUrl,
  eventName,
  runUrl,
  preset = 'mobile',
  generatedAt = new Date().toISOString(),
}) {
  const files = listReports(reportsDir);
  if (!files.some((name) => name.endsWith('.report.json'))) {
    throw new Error(`no Lighthouse JSON report in ${reportsDir}`);
  }
  const reports = files.map((name) => {
    const path = join(reportsDir, name);
    return {
      route: '/',
      slug: slugOf(name),
      format: name.endsWith('.json') ? 'json' : 'html',
      file: name,
      sha256: hashFile(path),
      bytes: statSync(path).size,
    };
  });
  const firstJson = files.find((name) => name.endsWith('.report.json'));
  const lhr = readLhr(reportsDir, slugOf(firstJson));
  return {
    generated_at: generatedAt,
    event_name: eventName,
    run_url: runUrl,
    app_url: appUrl,
    preset,
    lighthouse_version: lhr.lighthouseVersion ?? null,
    chrome_version: lhr.environment?.hostUserAgent ?? null,
    reports,
  };
}

/** Compares the current files with the recorded manifest. */
export function verifyReports(meta, reportsDir) {
  const mismatches = [];
  for (const report of meta.reports ?? []) {
    const path = join(reportsDir, report.file);
    if (!existsSync(path)) {
      mismatches.push(`${report.file} is missing`);
      continue;
    }
    const actual = hashFile(path);
    if (actual !== report.sha256) {
      mismatches.push(`${report.file} sha256 ${actual} != recorded ${report.sha256}`);
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

/** True when both URLs share an origin (guards against suffix look-alikes). */
export function sameOrigin(value, appUrl) {
  try {
    return new URL(value).origin === new URL(appUrl).origin;
  } catch {
    return false;
  }
}

/**
 * Refuses to hand an audit to the model when the page did not really load:
 * a cold instance, a database error or an SPA that failed to mount would
 * otherwise produce invented findings.
 */
export function checkLhr(lhr, { appUrl }) {
  const problems = [];
  if (!lhr || typeof lhr !== 'object') return ['the report is not an object'];
  if (lhr.runtimeError) {
    problems.push(`runtimeError: ${lhr.runtimeError.code} ${lhr.runtimeError.message ?? ''}`.trim());
  }
  if (!sameOrigin(lhr.finalDisplayedUrl, appUrl)) {
    problems.push(`finalDisplayedUrl ${lhr.finalDisplayedUrl} is not on ${appUrl}`);
  }
  if (!lhr.categories?.performance) {
    problems.push('the performance category is missing');
  }
  const requests = lhr.audits?.['network-requests']?.details?.items ?? [];
  const failed = requests.filter((item) => Number(item.statusCode) >= 500);
  if (failed.length > 0) {
    problems.push(
      `${failed.length} request(s) answered 5xx: ${failed
        .slice(0, 3)
        .map((item) => `${item.statusCode} ${item.url}`)
        .join(', ')}`,
    );
  }
  const succeeded = requests.filter(
    (item) => Number(item.statusCode) >= 200 && Number(item.statusCode) < 400,
  );
  if (succeeded.length < 2) {
    problems.push('the page loaded almost nothing successfully');
  }
  if (!lhr.audits?.['largest-contentful-paint']) {
    problems.push('the LCP metric is missing');
  }
  return problems;
}

function truncate(value, limit) {
  const text = String(value ?? '');
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * Cuts a string to a byte budget without splitting a UTF-8 character. The cap
 * and its message are byte-based; `slice` would count UTF-16 code units.
 */
export function truncateBytes(value, limit) {
  const text = String(value ?? '');
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= limit) return text;
  let end = limit;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

function savings(audit) {
  const bytes = audit.details?.overallSavingsBytes;
  const ms = audit.details?.overallSavingsMs;
  const parts = [];
  if (Number.isFinite(bytes) && bytes > 0) parts.push(`${Math.round(bytes / 1024)} KiB`);
  if (Number.isFinite(ms) && ms > 0) parts.push(`${Math.round(ms)} ms`);
  return parts.length > 0 ? parts.join(' / ') : null;
}

function detailItems(audit) {
  const items = audit.details?.items;
  if (!Array.isArray(items) || items.length === 0) return [];
  return items.slice(0, MAX_DETAIL_ITEMS).map((item) => {
    const copy = { ...item };
    if (copy.node) copy.node = truncate(JSON.stringify(copy.node), MAX_DETAIL_CHARS);
    return truncate(JSON.stringify(copy), MAX_DETAIL_CHARS);
  });
}

/**
 * Keeps only failing, machine-readable audits. `manual`, `informative` and
 * `notApplicable` entries cannot be verified and must not become issues.
 */
export function failingAudits(lhr) {
  const seen = new Set();
  const failures = [];
  for (const categoryId of SUMMARY_CATEGORIES) {
    const category = lhr.categories?.[categoryId];
    if (!category) continue;
    for (const ref of category.auditRefs ?? []) {
      if (seen.has(ref.id)) continue;
      const audit = lhr.audits?.[ref.id];
      if (!audit) continue;
      if (NON_FAILING_MODES.has(audit.scoreDisplayMode)) continue;
      if (audit.score === null || audit.score === undefined || audit.score >= 1) continue;
      seen.add(ref.id);
      failures.push({
        id: ref.id,
        category: categoryId,
        weight: ref.weight ?? null,
        title: audit.title,
        score: audit.score,
        displayValue: audit.displayValue ?? null,
        savings: savings(audit),
        description: truncate(audit.description, MAX_DESCRIPTION_CHARS),
        items: detailItems(audit),
        errorMessage: audit.errorMessage ?? null,
      });
    }
  }
  return failures;
}

/** Path of the page Lighthouse actually audited. */
export function auditedRoute(lhr) {
  const value = lhr?.finalDisplayedUrl;
  if (!value) return '/';
  try {
    return new URL(value).pathname || '/';
  } catch {
    return '/';
  }
}

/**
 * The verifiable scope of a run: the routes that were audited and the failing
 * audit ids the digest lists. A finding outside it is model invention.
 * `include` carries the synthetic fixture in test mode, whose identity is part
 * of the digest but never comes from a report.
 */
export function auditScope(lhrs, { include = [] } = {}) {
  const routes = new Set();
  const audits = new Set();
  for (const lhr of lhrs) {
    routes.add(auditedRoute(lhr));
    for (const failure of failingAudits(lhr)) audits.add(failure.id);
  }
  for (const finding of include) {
    if (typeof finding?.route === 'string') routes.add(finding.route);
    if (typeof finding?.audit === 'string') audits.add(finding.audit);
  }
  return { routes: [...routes].sort(), audits: [...audits].sort() };
}

export function categoryScores(lhr) {
  const scores = {};
  for (const categoryId of SUMMARY_CATEGORIES) {
    const category = lhr.categories?.[categoryId];
    if (!category) continue;
    scores[categoryId] = category.score === null ? null : Math.round(category.score * 100);
  }
  return scores;
}

export function coreMetrics(lhr) {
  const metrics = {};
  for (const id of METRIC_AUDITS) {
    const audit = lhr.audits?.[id];
    if (!audit) continue;
    metrics[id] = audit.displayValue ?? audit.numericValue ?? null;
  }
  return metrics;
}

export function networkProblems(lhr) {
  const requests = lhr.audits?.['network-requests']?.details?.items ?? [];
  return requests
    .filter((item) => Number(item.statusCode) >= 400)
    .slice(0, 10)
    .map((item) => `${item.statusCode} ${item.method ?? 'GET'} ${item.url}`);
}

function syntheticSection(finding) {
  return [
    '## Synthetic test finding (NOT a Lighthouse result)',
    '',
    'Injected by `test_mode`. The Lighthouse JSON and HTML reports were not modified.',
    'The sections above are the real audit; this block is pipeline verification data.',
    'It is not evidence of a problem in the application.',
    '',
    '```json',
    JSON.stringify(finding, null, 2),
    '```',
  ].join('\n');
}

export function buildContext({
  meta,
  lhrs,
  eventName,
  runUrl,
  testMode = false,
  contextFinding = null,
}) {
  const lines = [];
  lines.push('# Lighthouse audit context');
  lines.push('');
  lines.push(`- App URL: ${meta.app_url}`);
  lines.push(`- Generated at: ${meta.generated_at}`);
  lines.push(`- Audit event: ${eventName}`);
  lines.push(`- Workflow run: ${runUrl}`);
  lines.push(`- Preset: ${meta.preset}`);
  lines.push(`- Lighthouse: ${meta.lighthouse_version}`);
  lines.push(`- Chrome: ${meta.chrome_version}`);
  lines.push('');
  lines.push(
    'Only audits that can be verified from the report are listed. Manual, informative and not-applicable audits are excluded.',
  );
  lines.push('');

  for (const lhr of lhrs) {
    const scores = categoryScores(lhr);
    lines.push(`## ${lhr.finalDisplayedUrl ?? meta.app_url}`);
    lines.push('');
    lines.push('### Category scores');
    lines.push('');
    lines.push('| Category | Score |');
    lines.push('| --- | --- |');
    for (const [category, score] of Object.entries(scores)) {
      lines.push(`| ${category} | ${score === null ? 'n/a' : score} |`);
    }
    lines.push('');
    lines.push('### Core metrics');
    lines.push('');
    for (const [id, value] of Object.entries(coreMetrics(lhr))) {
      lines.push(`- ${id}: ${value}`);
    }
    lines.push('');
    lines.push('### Failing audits');
    lines.push('');
    const failures = failingAudits(lhr);
    if (failures.length === 0) {
      lines.push('No failing machine-readable audit was found.');
      lines.push('');
    }
    for (const failure of failures) {
      lines.push(
        `#### ${failure.id} (${failure.category}) — ${failure.title}`,
      );
      lines.push('');
      lines.push(
        `- Score: ${failure.score}; weight: ${failure.weight ?? 'n/a'}; displayed: ${failure.displayValue ?? 'n/a'}`,
      );
      if (failure.savings) lines.push(`- Potential savings: ${failure.savings}`);
      if (failure.errorMessage) lines.push(`- Error: ${failure.errorMessage}`);
      if (failure.description) lines.push(`- What it checks: ${failure.description}`);
      for (const item of failure.items) {
        lines.push(`- Evidence: ${truncate(item, MAX_DETAIL_CHARS)}`);
      }
      lines.push('');
    }
    const problems = networkProblems(lhr);
    if (problems.length > 0) {
      lines.push('### Network problems');
      lines.push('');
      for (const problem of problems) lines.push(`- ${problem}`);
      lines.push('');
    }
  }

  if (testMode && contextFinding) {
    lines.push(syntheticSection(contextFinding));
    lines.push('');
  }

  const context = `${lines.join('\n')}\n`;
  if (Buffer.byteLength(context) > MAX_CONTEXT_BYTES) {
    const note = `\n\n_Context truncated at ${MAX_CONTEXT_BYTES} bytes._\n`;
    const budget = MAX_CONTEXT_BYTES - Buffer.byteLength(note);
    return `${truncateBytes(context, budget)}${note}`;
  }
  return context;
}

export function provenancePayload({
  contextPath,
  promptPath,
  eventName,
  testMode,
  createIssues,
  model,
  variant,
  lighthouseVersion,
  generatedAt = new Date().toISOString(),
}) {
  return {
    generated_at: generatedAt,
    event_name: eventName,
    test_mode: testMode,
    create_issues: createIssues,
    model,
    variant,
    lighthouse_version: lighthouseVersion,
    files: {
      'context.md': { sha256: hashFile(contextPath), bytes: statSync(contextPath).size },
      'prompt.md': { sha256: hashFile(promptPath), bytes: statSync(promptPath).size },
    },
    note: 'Reproducible record of the CLI inputs; it is not proof that the provider received these bytes.',
  };
}

function parseArgs(argv) {
  const args = { mode: null, testMode: false };
  let rest = argv;
  if (rest[0] && !rest[0].startsWith('--')) {
    args.mode = rest[0];
    rest = rest.slice(1);
  }
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    switch (value) {
      case '--mode':
        args.mode = rest[++index];
        break;
      case '--reports':
        args.reports = rest[++index];
        break;
      case '--report':
        args.report = rest[++index];
        break;
      case '--meta':
        args.meta = rest[++index];
        break;
      case '--out':
        args.out = rest[++index];
        break;
      case '--audits':
        args.audits = rest[++index];
        break;
      case '--context':
        args.context = rest[++index];
        break;
      case '--prompt':
        args.prompt = rest[++index];
        break;
      case '--app-url':
        args.appUrl = rest[++index];
        break;
      case '--run-url':
        args.runUrl = rest[++index];
        break;
      case '--event-name':
        args.eventName = rest[++index];
        break;
      case '--model':
        args.model = rest[++index];
        break;
      case '--variant':
        args.variant = rest[++index];
        break;
      case '--lighthouse-version':
        args.lighthouseVersion = rest[++index];
        break;
      case '--test-mode':
        args.testMode = true;
        break;
      default:
        throw new Error(`unknown argument: ${value}`);
    }
  }
  return args;
}

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    fail(error.message);
  }
  const mode = args.mode;
  if (!mode) fail('--mode is required: record, verify, check, build or provenance');

  if (args.testMode) {
    try {
      assertTestModeAllowed({ testMode: true, eventName: args.eventName });
    } catch (error) {
      fail(error.message);
    }
  }

  if (mode === 'check') {
    if (!args.report || !args.appUrl) fail('check needs --report and --app-url');
    const lhr = JSON.parse(readFileSync(args.report, 'utf8'));
    const problems = checkLhr(lhr, { appUrl: args.appUrl });
    if (problems.length > 0) fail(`the audit is not valid: ${problems.join('; ')}`);
    return;
  }

  if (mode === 'record') {
    if (!args.reports || !args.meta) fail('record needs --reports and --meta');
    const meta = recordReports({
      reportsDir: args.reports,
      appUrl: args.appUrl,
      eventName: args.eventName,
      runUrl: args.runUrl,
    });
    writeFileSync(args.meta, `${JSON.stringify(meta, null, 2)}\n`);
    return;
  }

  if (mode === 'verify') {
    if (!args.meta || !args.reports) fail('verify needs --meta and --reports');
    const meta = JSON.parse(readFileSync(args.meta, 'utf8'));
    const result = verifyReports(meta, args.reports);
    if (!result.ok) fail(`report hashes changed: ${result.mismatches.join('; ')}`);
    return;
  }

  if (mode === 'build') {
    if (!args.meta || !args.reports || !args.out) {
      fail('build needs --meta, --reports and --out');
    }
    const meta = JSON.parse(readFileSync(args.meta, 'utf8'));
    const verified = verifyReports(meta, args.reports);
    if (!verified.ok) {
      fail(`report hashes changed before analysis: ${verified.mismatches.join('; ')}`);
    }
    const slugs = [...new Set((meta.reports ?? []).map((report) => report.slug))];
    const lhrs = slugs.map((slug) => readLhr(args.reports, slug));
    const contextFinding = args.testMode ? testFinding() : null;
    const context = buildContext({
      meta,
      lhrs,
      eventName: args.eventName,
      runUrl: args.runUrl,
      testMode: args.testMode,
      contextFinding,
    });
    writeFileSync(args.out, context);
    if (args.audits) {
      const scope = auditScope(lhrs, {
        include: contextFinding ? [contextFinding] : [],
      });
      writeFileSync(args.audits, `${JSON.stringify(scope, null, 2)}\n`);
    }
    const after = verifyReports(meta, args.reports);
    if (!after.ok) {
      fail(`digest generation modified a report: ${after.mismatches.join('; ')}`);
    }
    return;
  }

  if (mode === 'provenance') {
    if (!args.context || !args.prompt || !args.out) {
      fail('provenance needs --context, --prompt and --out');
    }
    const meta = args.meta ? JSON.parse(readFileSync(args.meta, 'utf8')) : null;
    const payload = provenancePayload({
      contextPath: args.context,
      promptPath: args.prompt,
      eventName: args.eventName,
      testMode: args.testMode,
      createIssues: parseBooleanEnv(process.env.CREATE_ISSUES ?? 'false', 'CREATE_ISSUES'),
      model: args.model ?? 'unknown',
      variant: args.variant ?? 'unknown',
      lighthouseVersion: args.lighthouseVersion ?? meta?.lighthouse_version ?? null,
    });
    writeFileSync(args.out, `${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  fail(`unknown mode: ${mode}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
