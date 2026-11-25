import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  buildContext,
  checkLhr,
  coreMetrics,
  failingAudits,
  hashFile,
  provenancePayload,
  recordReports,
  verifyReports,
} from './lighthouse-digest.mjs';
import { TEST_FINDING_FINGERPRINT } from './lighthouse-test-fixture.mjs';

const APP_URL = 'https://app.test';
const RUN_URL = 'https://github.com/owner/repo/actions/runs/1';

function lhr(overrides = {}) {
  return {
    lighthouseVersion: '12.8.2',
    finalDisplayedUrl: `${APP_URL}/`,
    requestedUrl: `${APP_URL}/`,
    runtimeError: null,
    environment: { hostUserAgent: 'Mozilla/5.0 Chrome/140.0.0.0' },
    categories: {
      performance: {
        score: 0.7,
        auditRefs: [
          { id: 'uses-long-cache-ttl' },
          { id: 'largest-contentful-paint' },
          { id: 'manual-audit' },
        ],
      },
      accessibility: { score: 1, auditRefs: [] },
      seo: { score: 1, auditRefs: [] },
      'best-practices': { score: 1, auditRefs: [{ id: 'errors-in-console' }] },
    },
    audits: {
      'uses-long-cache-ttl': {
        id: 'uses-long-cache-ttl',
        title: 'Serve static assets with an efficient cache policy',
        description: 'A long cache lifetime can speed up repeat visits.',
        score: 0,
        scoreDisplayMode: 'numeric',
        displayValue: '2 resources found',
        details: {
          overallSavingsBytes: 409600,
          items: [
            {
              url: `${APP_URL}/assets/index-C519h91O.js`,
              cacheLifetimeMs: 0,
            },
            {
              url: `${APP_URL}/assets/index-DKB5k78O.css`,
              cacheLifetimeMs: 0,
            },
          ],
        },
      },
      'largest-contentful-paint': {
        id: 'largest-contentful-paint',
        title: 'Largest Contentful Paint',
        score: 0.5,
        scoreDisplayMode: 'numeric',
        displayValue: '3.2 s',
      },
      'errors-in-console': {
        id: 'errors-in-console',
        title: 'No browser errors logged to the console',
        score: 1,
        scoreDisplayMode: 'binary',
        details: { items: [] },
      },
      'manual-audit': {
        id: 'manual-audit',
        title: 'Manual check',
        score: 0,
        scoreDisplayMode: 'manual',
      },
      'network-requests': {
        details: {
          items: [
            { url: `${APP_URL}/`, statusCode: 200 },
            { url: `${APP_URL}/assets/index-C519h91O.js`, statusCode: 200 },
          ],
        },
      },
    },
    ...overrides,
  };
}

function writeReports() {
  const dir = mkdtempSync(join(tmpdir(), 'lighthouse-digest-'));
  writeFileSync(join(dir, 'landing.report.json'), `${JSON.stringify(lhr(), null, 2)}\n`);
  writeFileSync(join(dir, 'landing.report.html'), '<html><body>Lighthouse report</body></html>\n');
  return dir;
}

function record(dir) {
  return recordReports({
    reportsDir: dir,
    appUrl: APP_URL,
    eventName: 'workflow_dispatch',
    runUrl: RUN_URL,
    generatedAt: '2026-01-01T00:00:00.000Z',
  });
}

test('the manifest records exact bytes and verifies them', (t) => {
  const dir = writeReports();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const meta = record(dir);
  assert.equal(meta.reports.length, 2);
  assert.equal(meta.lighthouse_version, '12.8.2');
  assert.match(meta.chrome_version, /Chrome/);
  for (const report of meta.reports) {
    assert.equal(report.sha256, hashFile(join(dir, report.file)));
    assert.ok(report.bytes > 0);
  }
  assert.deepEqual(verifyReports(meta, dir), { ok: true, mismatches: [] });

  writeFileSync(join(dir, 'landing.report.html'), 'tampered');
  const broken = verifyReports(meta, dir);
  assert.equal(broken.ok, false);
  assert.match(broken.mismatches.join(' '), /landing\.report\.html/);
});

test('only failing machine-readable audits reach the context', () => {
  const audits = failingAudits(lhr());
  assert.deepEqual(
    audits.map((audit) => audit.id),
    ['uses-long-cache-ttl', 'largest-contentful-paint'],
  );
  assert.equal(audits[0].savings, '400 KiB');
  assert.equal(audits[0].items.length, 2);
  assert.ok(!audits.some((audit) => audit.id === 'manual-audit'));
});

test('category scores and core metrics are summarised', () => {
  const data = lhr();
  assert.equal(coreMetrics(data)['largest-contentful-paint'], '3.2 s');
  assert.equal(coreMetrics(data)['uses-long-cache-ttl'], undefined);
});

test('the real context contains scores, evidence and no synthetic section', (t) => {
  const dir = writeReports();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const meta = record(dir);

  const context = buildContext({
    meta,
    lhrs: [lhr()],
    eventName: 'workflow_dispatch',
    runUrl: RUN_URL,
  });
  assert.match(context, /\| performance \| 70 \|/);
  assert.match(context, /uses-long-cache-ttl/);
  assert.match(context, /index-C519h91O\.js/);
  assert.doesNotMatch(context, /Synthetic test finding/);
  assert.doesNotMatch(context, /"synthetic": true/);
});

test('test mode injects exactly one synthetic finding and changes no report byte', (t) => {
  const dir = writeReports();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const meta = record(dir);
  const before = Object.fromEntries(
    meta.reports.map((report) => [report.file, hashFile(join(dir, report.file))]),
  );

  const context = buildContext({
    meta,
    lhrs: [lhr()],
    eventName: 'workflow_dispatch',
    runUrl: RUN_URL,
    testMode: true,
    contextFinding: {
      id: 'test-uses-long-cache-ttl',
      synthetic: true,
      audit: 'uses-long-cache-ttl',
      route: '/',
    },
  });

  assert.equal(context.match(/## Synthetic test finding/g).length, 1);
  assert.equal(context.match(/"synthetic": true/g).length, 1);
  assert.match(context, /NOT a Lighthouse result/);
  assert.match(context, /reports were not modified/);
  assert.match(context, /uses-long-cache-ttl/);
  for (const [file, hash] of Object.entries(before)) {
    assert.equal(hashFile(join(dir, file)), hash, `${file} must not change`);
  }
  assert.equal(verifyReports(meta, dir).ok, true);
});

test('the test finding uses the frozen fingerprint when injected', (t) => {
  const dir = writeReports();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const context = buildContext({
    meta: record(dir),
    lhrs: [lhr()],
    eventName: 'workflow_dispatch',
    runUrl: RUN_URL,
    testMode: true,
    contextFinding: {
      id: 'test-uses-long-cache-ttl',
      synthetic: true,
      audit: 'uses-long-cache-ttl',
      route: '/',
      fingerprint: TEST_FINDING_FINGERPRINT,
    },
  });
  assert.match(context, new RegExp(TEST_FINDING_FINGERPRINT));
});

test('validity gate rejects runtime errors, 5xx and missing metrics', () => {
  assert.deepEqual(checkLhr(lhr(), { appUrl: APP_URL }), []);

  const broken = [
    checkLhr(lhr({ runtimeError: { code: 'NO_FCP', message: 'did not paint' } }), {
      appUrl: APP_URL,
    }),
    checkLhr(
      lhr({
        audits: {
          ...lhr().audits,
          'network-requests': {
            details: { items: [{ url: `${APP_URL}/meeting-types`, statusCode: 500 }] },
          },
        },
      }),
      { appUrl: APP_URL },
    ),
    checkLhr(lhr({ audits: {} }), { appUrl: APP_URL }),
    checkLhr(lhr({ finalDisplayedUrl: 'https://other.test/' }), { appUrl: APP_URL }),
    checkLhr(lhr({ finalDisplayedUrl: `${APP_URL}.evil/` }), { appUrl: APP_URL }),
  ];
  for (const problems of broken) {
    assert.ok(problems.length > 0);
  }
});

test('provenance pins the CLI inputs', (t) => {
  const dir = writeReports();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const contextPath = join(dir, 'context.md');
  const promptPath = join(dir, 'prompt.md');
  writeFileSync(contextPath, '# context\n');
  writeFileSync(promptPath, '# prompt\n');

  const payload = provenancePayload({
    contextPath,
    promptPath,
    eventName: 'workflow_dispatch',
    testMode: false,
    createIssues: true,
    model: 'opencode/deepseek-v4.1-flash',
    variant: 'low',
    lighthouseVersion: '12.8.2',
    generatedAt: '2026-01-01T00:00:00.000Z',
  });

  assert.equal(payload.files['context.md'].sha256, hashFile(contextPath));
  assert.equal(payload.files['prompt.md'].sha256, hashFile(promptPath));
  assert.match(payload.note, /not proof/);
  assert.equal(payload.test_mode, false);
  assert.equal(payload.create_issues, true);
});
