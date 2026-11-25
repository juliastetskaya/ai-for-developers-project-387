import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  applyTestTitle,
  buildTestMarker,
  findingFingerprint,
  parseIssueMarkers,
  reviewFinding,
  testIssueLabels,
} from './lighthouse-findings.mjs';
import {
  TEST_FINDING,
  TEST_FINDING_CANONICAL,
  TEST_FINDING_FINGERPRINT,
  computedTestFingerprint,
  testFinding,
} from './lighthouse-test-fixture.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The fixture is a frozen contract: the demonstration must stay reproducible, so
 * every identity and evidence field is asserted literally.
 */
test('the synthetic fixture is frozen field by field', () => {
  assert.deepEqual(testFinding(), {
    id: 'test-uses-long-cache-ttl',
    synthetic: true,
    source: 'test_mode',
    route: '/',
    audit: 'uses-long-cache-ttl',
    scope: '/assets/index-<hash>.js',
    category: 'performance',
    severity: 'low',
    title: 'Serve hashed static assets with a long-lived immutable cache header',
    evidence: {
      resource: '/assets/index-<hash>.js',
      observation: 'responded with cache-control: public, max-age=0',
    },
    repo_evidence: {
      file: 'apps/backend/src/static-frontend.ts',
      symbol: 'configureStaticFrontend',
    },
    fix: 'In configureStaticFrontend, serve /assets/* with setHeaders({ "Cache-Control": "public, max-age=31536000, immutable" }) and keep index.html uncached.',
    impact: 'Repeat visits and route navigations can reuse the hashed JavaScript and CSS bundle instead of revalidating it on every request.',
    fingerprint: '582f378dfa6c0628',
  });
  assert.ok(Object.isFrozen(TEST_FINDING));
  assert.ok(Object.isFrozen(TEST_FINDING_CANONICAL));
});

test('the test fingerprint is frozen and derived from the identity only', () => {
  assert.equal(TEST_FINDING_FINGERPRINT, '582f378dfa6c0628');
  assert.equal(computedTestFingerprint(), TEST_FINDING_FINGERPRINT);
  assert.equal(findingFingerprint(TEST_FINDING), TEST_FINDING_FINGERPRINT);
  assert.equal(findingFingerprint(TEST_FINDING_CANONICAL), TEST_FINDING_FINGERPRINT);
  assert.match(TEST_FINDING_FINGERPRINT, /^[0-9a-f]{16}$/);
});

test('the synthetic marker round-trips as a test marker only', () => {
  const markers = parseIssueMarkers(buildTestMarker(TEST_FINDING_CANONICAL));
  assert.deepEqual(markers.test, [
    { fingerprint: TEST_FINDING_FINGERPRINT, route: '/', audit: 'uses-long-cache-ttl' },
  ]);
  assert.deepEqual(markers.real, []);
});

test('the synthetic issue keeps its [TEST] title and dedicated label', () => {
  assert.equal(
    applyTestTitle(TEST_FINDING.title),
    '[TEST] Serve hashed static assets with a long-lived immutable cache header',
  );
  assert.equal(applyTestTitle(applyTestTitle(TEST_FINDING.title)), applyTestTitle(TEST_FINDING.title));
  assert.deepEqual(testIssueLabels(), ['lighthouse-test']);
});

test('repo_evidence of the fixture points at real code', () => {
  const file = join(root, TEST_FINDING.repo_evidence.file);
  assert.ok(existsSync(file), `${TEST_FINDING.repo_evidence.file} must exist`);
  const source = readFileSync(file, 'utf8');
  assert.ok(
    source.includes(TEST_FINDING.repo_evidence.symbol),
    `${TEST_FINDING.repo_evidence.file} must still contain ${TEST_FINDING.repo_evidence.symbol}; update the fixture and its fingerprint together`,
  );
});

test('the fixture passes the test-mode gate and fails the real-mode gate', () => {
  const asTest = reviewFinding(TEST_FINDING_CANONICAL, { mode: 'test' });
  assert.equal(asTest.ok, true, asTest.reason);
  const asReal = reviewFinding(TEST_FINDING_CANONICAL, { mode: 'real' });
  assert.equal(asReal.ok, false);
  assert.match(asReal.reason, /synthetic/);

  const real = {
    ...TEST_FINDING_CANONICAL,
    id: 'real-finding',
    synthetic: false,
    fingerprint: undefined,
  };
  assert.equal(reviewFinding(real, { mode: 'real' }).ok, true);
  assert.equal(reviewFinding(real, { mode: 'test' }).ok, false);
});
