import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyTestTitle,
  assertTestModeAllowed,
  buildMarker,
  buildTestMarker,
  extractFindings,
  findingFingerprint,
  findSoftDuplicate,
  normaliseResource,
  normaliseSelector,
  parseBooleanEnv,
  parseIssueMarkers,
  realIssueLabels,
  reviewFinding,
  testIssueLabels,
  titleSimilarity,
  validateFinding,
} from './lighthouse-findings.mjs';

function finding(overrides = {}) {
  return {
    id: 'cache-hashed-assets',
    route: '/',
    audit: 'uses-long-cache-ttl',
    category: 'performance',
    severity: 'medium',
    title: 'Serve hashed assets with a long immutable cache header',
    evidence: { resource: '/assets/index-abc12345.js' },
    repo_evidence: {
      file: 'apps/backend/src/static-frontend.ts',
      symbol: 'configureStaticFrontend',
    },
    fix: 'Set a long max-age and immutable on /assets responses.',
    impact: 'Repeat visits reuse the bundle instead of revalidating it.',
    ...overrides,
  };
}

test('resource normalisation collapses content hashes and query strings', () => {
  assert.equal(
    normaliseResource('https://app.test/assets/index-C519h91O.js?v=3'),
    '/assets/index-<hash>.js',
  );
  assert.equal(
    normaliseResource('/assets/chunk-A1b2C3d4E5.css'),
    '/assets/chunk-<hash>.css',
  );
  assert.equal(normaliseResource('/book'), '/book');
  assert.equal(normaliseResource(''), '/');
});

test('content hashes containing a hyphen are normalised too', () => {
  assert.equal(
    normaliseResource('/assets/index-AbC-dEf1Gh.js'),
    '/assets/index-<hash>.js',
  );
  assert.equal(
    normaliseResource('/assets/chunk-aB-cD_eF1Gh.css?v=2'),
    '/assets/chunk-<hash>.css',
  );
});

test('selector normalisation drops positional pseudo-classes and spacing', () => {
  assert.equal(
    normaliseSelector('MAIN > DIV:nth-child(2)  >  SPAN'),
    'main>div>span',
  );
});

test('fingerprint depends on route, audit and scope, never on scores', () => {
  const base = { route: '/', audit: 'uses-long-cache-ttl', scope: '/assets/index-<hash>.js' };
  const first = findingFingerprint(finding());
  assert.equal(findingFingerprint(finding()), first);
  assert.match(first, /^[0-9a-f]{16}$/);
  assert.equal(
    findingFingerprint(finding({ route: '/book' })),
    findingFingerprint({ ...finding(), route: '/book' }),
  );
  assert.notEqual(findingFingerprint(finding({ route: '/book' })), first);
  assert.notEqual(
    findingFingerprint(finding({ evidence: { resource: '/assets/other-abc12345.js' } })),
    first,
  );
  assert.notEqual(
    findingFingerprint({ route: base.route, audit: 'color-contrast', scope: base.scope }),
    first,
  );
  assert.equal(
    findingFingerprint(finding({ displayValue: '1 s', score: 0.1 })),
    first,
    'cosmetic fields must not change the fingerprint',
  );
});

test('markers round-trip and stay separated by family', () => {
  const real = buildMarker(finding());
  const synthetic = buildTestMarker(finding({ synthetic: true }));
  const body = `intro\n${real}\n${synthetic}\n`;
  const markers = parseIssueMarkers(body);
  assert.equal(markers.real.length, 1);
  assert.equal(markers.test.length, 1);
  assert.equal(markers.real[0].fingerprint, findingFingerprint(finding()));
  assert.equal(markers.test[0].fingerprint, findingFingerprint(finding()));
});

test('malformed markers are ignored instead of crashing deduplication', () => {
  const markers = parseIssueMarkers('<!-- lighthouse-finding: not json -->');
  assert.deepEqual(markers.real, []);
});

test('boolean parsing is strict so a typo cannot silently disable a mode', () => {
  assert.equal(parseBooleanEnv('true', 'TEST_MODE'), true);
  assert.equal(parseBooleanEnv('false', 'TEST_MODE'), false);
  assert.throws(() => parseBooleanEnv('1', 'TEST_MODE'), /TEST_MODE/);
  assert.throws(() => parseBooleanEnv(undefined, 'CREATE_ISSUES'), /CREATE_ISSUES/);
});

test('test mode is rejected outside workflow_dispatch', () => {
  assert.doesNotThrow(() =>
    assertTestModeAllowed({ testMode: true, eventName: 'workflow_dispatch' }),
  );
  assert.throws(
    () => assertTestModeAllowed({ testMode: true, eventName: 'schedule' }),
    /workflow_dispatch/,
  );
  assert.doesNotThrow(() =>
    assertTestModeAllowed({ testMode: false, eventName: 'schedule' }),
  );
});

test('validation rejects incomplete findings', () => {
  const errors = validateFinding({ id: 'Bad Id', title: 'short' });
  assert.ok(errors.length >= 4);
  assert.deepEqual(validateFinding(finding()), []);
  assert.ok(
    validateFinding(finding({ repo_evidence: { file: '../etc/passwd', symbol: 'x' } }))
      .some((error) => error.includes('relative')),
  );
  assert.ok(
    validateFinding(finding({ repo_evidence: { file: 'package.json', symbol: 'a' } }))
      .some((error) => error.includes('at least 3 characters')),
  );
});

test('the digest scope rejects invented audits and routes', () => {
  const scope = { routes: ['/'], audits: ['uses-long-cache-ttl'] };
  const deps = { fileExists: () => true, fileContains: () => true };
  assert.equal(
    reviewFinding(finding(), { mode: 'real', scope, ...deps }).ok,
    true,
  );
  const inventedAudit = reviewFinding(
    finding({ audit: 'made-up-audit' }),
    { mode: 'real', scope, ...deps },
  );
  assert.equal(inventedAudit.ok, false);
  assert.match(inventedAudit.reason, /not in the digest/);
  const inventedRoute = reviewFinding(
    finding({ route: '/book' }),
    { mode: 'real', scope, ...deps },
  );
  assert.equal(inventedRoute.ok, false);
  assert.match(inventedRoute.reason, /was not audited/);

  // A run with no failing audit allows nothing: an empty list is not a wildcard.
  for (const empty of [
    { routes: ['/'], audits: [] },
    { routes: [], audits: ['uses-long-cache-ttl'] },
  ]) {
    const rejected = reviewFinding(finding(), { mode: 'real', scope: empty, ...deps });
    assert.equal(rejected.ok, false);
  }
});

test('a directory named as repository evidence rejects the finding instead of throwing', () => {
  const review = reviewFinding(
    finding({ repo_evidence: { file: 'scripts', symbol: 'configureStaticFrontend' } }),
    { mode: 'real', fileExists: () => true },
  );
  assert.equal(review.ok, false);
  assert.match(review.reason, /is not in scripts/);
});

test('findings block extraction tolerates arrays and reports a missing block', () => {
  const report = [
    '# Report',
    '',
    '<!-- lighthouse-findings -->',
    '```json',
    JSON.stringify({ findings: [finding()] }),
    '```',
  ].join('\n');
  const parsed = extractFindings(report);
  assert.equal(parsed.error, null);
  assert.equal(parsed.findings.length, 1);

  const arrayForm = extractFindings(
    ['<!-- lighthouse-findings -->', '```json', JSON.stringify([finding()]), '```'].join('\n'),
  );
  assert.equal(arrayForm.findings.length, 1);

  assert.match(extractFindings('# no block').error, /lighthouse-findings/);
  assert.match(
    extractFindings(['<!-- lighthouse-findings -->', '```json', '{', '```'].join('\n')).error,
    /invalid/,
  );
});

test('titles are compared as a veto, not as the primary key', () => {
  const existing = [
    { number: 7, title: 'Serve hashed assets with a long immutable cache header' },
    { number: 8, title: 'Add a meta description to the landing page' },
  ];
  assert.ok(titleSimilarity(existing[0].title, finding().title) >= 0.8);
  assert.equal(findSoftDuplicate(finding().title, existing).issue.number, 7);
  assert.equal(findSoftDuplicate('Improve colour contrast of slot buttons', existing), null);
});

test('[TEST] title prefixing is idempotent', () => {
  assert.equal(applyTestTitle('Cache assets'), '[TEST] Cache assets');
  assert.equal(applyTestTitle('[TEST] Cache assets'), '[TEST] Cache assets');
  assert.equal(applyTestTitle('[test]   [TEST] Cache assets'), '[TEST] Cache assets');
});

test('label sets separate synthetic issues from real ones', () => {
  assert.deepEqual(realIssueLabels(finding({ severity: 'high' })), [
    'lighthouse',
    'performance',
    'bug',
  ]);
  assert.deepEqual(realIssueLabels(finding({ severity: 'low' })), [
    'lighthouse',
    'performance',
    'enhancement',
  ]);
  assert.deepEqual(testIssueLabels(), ['lighthouse-test']);
});
