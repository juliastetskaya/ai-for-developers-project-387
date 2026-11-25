import { fingerprint } from './lighthouse-findings.mjs';

/**
 * Deterministic, synthetic finding used by `workflow_dispatch` with
 * `test_mode=true`. It never comes from a Lighthouse report: the workflow
 * appends it to the AI context to exercise validation, deduplication and issue
 * publishing end to end.
 *
 * The fingerprint is frozen. It is derived from the identity of the finding
 * (route, audit, scope), not from scores or dates, so repeated test runs match
 * the same issue instead of creating duplicates:
 *
 *   sha256('lh1|/|uses-long-cache-ttl|/assets/index-<hash>.js').slice(0, 16)
 */
export const TEST_FINDING_FINGERPRINT = '582f378dfa6c0628';

export const TEST_FINDING = Object.freeze({
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
});

export const TEST_FINDING_CANONICAL = Object.freeze({
  ...TEST_FINDING,
  fingerprint: TEST_FINDING_FINGERPRINT,
});

export function testFinding() {
  return JSON.parse(JSON.stringify(TEST_FINDING_CANONICAL));
}

/** The fingerprint recomputed from the fixture identity, for integrity checks. */
export function computedTestFingerprint() {
  return fingerprint({
    route: TEST_FINDING.route,
    audit: TEST_FINDING.audit,
    scope: TEST_FINDING.scope,
  });
}
