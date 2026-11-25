import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildMarker,
  buildTestMarker,
  findingFingerprint,
} from './lighthouse-findings.mjs';
import {
  TEST_FINDING_FINGERPRINT,
  testFinding,
} from './lighthouse-test-fixture.mjs';
import {
  buildTestIssue,
  executePlan,
  planIssues,
  renderDecisions,
  renderIssues,
  renderProposed,
  summaryLines,
} from './lighthouse-issues.mjs';

const LINKS = {
  runUrl: 'https://github.com/acme/repo/actions/runs/1',
  appUrl: 'https://app.test',
};

function realFinding(overrides = {}) {
  return {
    id: 'cache-hashed-assets',
    route: '/',
    audit: 'uses-long-cache-ttl',
    category: 'performance',
    severity: 'medium',
    title: 'Serve hashed static assets with an efficient cache policy',
    evidence: { resource: '/assets/index-abc12345.js', observation: 'max-age=0' },
    repo_evidence: { file: 'package.json', symbol: '"name"' },
    fix: 'Set a long max-age and immutable for /assets responses.',
    impact: 'Repeat visits reuse the bundle instead of revalidating it.',
    ...overrides,
  };
}

function reportWith(findings) {
  return [
    '# Lighthouse analysis',
    '',
    '<!-- lighthouse-findings -->',
    '```json',
    JSON.stringify({ findings }, null, 2),
    '```',
  ].join('\n');
}

const deps = { fileExists: () => true, fileContains: () => true };

function issue(number, finding, { kind = 'real' } = {}) {
  const marker =
    kind === 'test' ? buildTestMarker(finding) : buildMarker(finding);
  return {
    number,
    state: 'OPEN',
    title: 'Existing issue',
    url: `https://github.com/acme/repo/issues/${number}`,
    body: `intro\n${marker}\n`,
  };
}

function fakeGh({ issues = {}, onCreate } = {}) {
  const calls = [];
  const runGh = (args) => {
    calls.push(args);
    if (args[0] === 'issue' && args[1] === 'list') {
      const label = args[args.indexOf('--label') + 1];
      const value = typeof issues === 'function' ? issues(label, calls) : issues[label];
      return JSON.stringify(value ?? []);
    }
    if (args[0] === 'issue' && args[1] === 'create') {
      return `${onCreate ?? 'https://github.com/acme/repo/issues/42'}\n`;
    }
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  return { runGh, calls };
}

test('a validated real finding becomes an issue with lighthouse labels', () => {
  const plan = planIssues({
    report: reportWith([realFinding()]),
    testMode: false,
    createIssues: true,
    existingReal: [],
    existingTest: [],
    links: LINKS,
    deps,
  });

  assert.equal(plan.error, null);
  const item = plan.items[0];
  assert.equal(item.decision, 'create');
  assert.equal(item.fingerprint, findingFingerprint(realFinding()));
  assert.deepEqual(item.labels, ['lighthouse', 'performance', 'bug']);
  assert.match(item.body, /<!-- lighthouse-finding: /);
  assert.match(item.body, /Automated finding from the scheduled Lighthouse audit/);
  assert.match(item.body, /package\.json/);
});

test('an existing fingerprint blocks a second issue', () => {
  const finding = realFinding();
  const plan = planIssues({
    report: reportWith([finding]),
    testMode: false,
    createIssues: true,
    existingReal: [issue(7, finding)],
    existingTest: [],
    links: LINKS,
    deps,
  });
  assert.equal(plan.items[0].decision, 'duplicate');
  assert.equal(plan.items[0].duplicate.number, 7);
});

test('a near-identical title is a veto, not a duplicate key', () => {
  const plan = planIssues({
    report: reportWith([realFinding()]),
    testMode: false,
    createIssues: true,
    existingReal: [
      {
        number: 9,
        state: 'OPEN',
        title: 'Serve hashed static assets with an efficient cache policy',
        url: 'https://github.com/acme/repo/issues/9',
        body: 'no marker here',
      },
    ],
    existingTest: [],
    links: LINKS,
    deps,
  });
  assert.equal(plan.items[0].decision, 'possible_duplicate');
  assert.equal(plan.items[0].duplicate.number, 9);
});

test('a finding outside the digest scope is not actionable', () => {
  const plan = planIssues({
    report: reportWith([realFinding({ audit: 'made-up-audit' })]),
    testMode: false,
    createIssues: true,
    existingReal: [],
    existingTest: [],
    links: LINKS,
    scope: { routes: ['/'], audits: ['uses-long-cache-ttl'] },
    deps,
  });
  assert.equal(plan.items[0].decision, 'not_actionable');
  assert.match(plan.items[0].reason, /not in the digest/);
});

test('a fingerprinted issue never vetoes a different finding by title', () => {
  const existing = issue(12, realFinding({ route: '/book' }));
  existing.title = realFinding().title;
  const plan = planIssues({
    report: reportWith([realFinding()]),
    testMode: false,
    createIssues: true,
    existingReal: [existing],
    existingTest: [],
    links: LINKS,
    deps,
  });
  assert.equal(plan.items[0].decision, 'create');
});

test('test mode publishes only the synthetic finding and suppresses real ones', () => {
  const plan = planIssues({
    report: reportWith([realFinding(), testFinding()]),
    testMode: true,
    createIssues: true,
    existingReal: [],
    existingTest: [],
    links: LINKS,
    deps,
  });

  const real = plan.items.filter((item) => item.kind === 'real');
  assert.equal(real.length, 1);
  assert.equal(real[0].decision, 'suppressed');

  const synthetic = plan.items.find((item) => item.kind === 'test');
  assert.equal(synthetic.decision, 'create');
  assert.equal(synthetic.fingerprint, TEST_FINDING_FINGERPRINT);
  assert.equal(synthetic.title.startsWith('[TEST] '), true);
  assert.deepEqual(synthetic.labels, ['lighthouse-test']);
  assert.match(synthetic.body, /lighthouse-test-finding/);
  assert.match(synthetic.body, /not\*\* a Lighthouse result/);
  assert.match(synthetic.body, /never reopened or deleted automatically/);
  assert.equal(synthetic.agent_included, true);
});

test('the synthetic issue is created even when the model drops it', () => {
  const plan = planIssues({
    report: reportWith([]),
    testMode: true,
    createIssues: true,
    existingReal: [],
    existingTest: [],
    links: LINKS,
    deps,
  });
  const synthetic = plan.items.find((item) => item.kind === 'test');
  assert.equal(synthetic.decision, 'create');
  assert.equal(synthetic.agent_included, false);
});

test('the stable fingerprint prevents repeated test issues', () => {
  const plan = planIssues({
    report: reportWith([testFinding()]),
    testMode: true,
    createIssues: true,
    existingReal: [],
    existingTest: [issue(3, testFinding(), { kind: 'test' })],
    links: LINKS,
    deps,
  });
  const synthetic = plan.items.find((item) => item.kind === 'test');
  assert.equal(synthetic.decision, 'duplicate');
  assert.equal(synthetic.duplicate.number, 3);
});

test('test issues are invisible to the real deduplication and vice versa', () => {
  const plan = planIssues({
    report: reportWith([realFinding()]),
    testMode: false,
    createIssues: true,
    // A test-labelled issue in the wrong list must not match a real finding.
    existingReal: [issue(5, testFinding(), { kind: 'test' })],
    existingTest: [],
    links: LINKS,
    deps,
  });
  assert.equal(plan.items[0].decision, 'create');
});

test('findings without repository evidence are never published', () => {
  const plan = planIssues({
    report: reportWith([realFinding()]),
    testMode: false,
    createIssues: true,
    existingReal: [],
    existingTest: [],
    links: LINKS,
    deps: { fileExists: () => false, fileContains: () => true },
  });
  assert.equal(plan.items[0].decision, 'not_actionable');
  assert.match(plan.items[0].reason, /does not exist/);
});

test('at most three real issues are created per run', () => {
  const findings = [
    realFinding(),
    realFinding({ audit: 'color-contrast', evidence: { selector: 'a.cta' } }),
    realFinding({ audit: 'meta-description', evidence: { resource: '/' } }),
    realFinding({ audit: 'link-name', evidence: { selector: 'a.icon' } }),
  ];
  const plan = planIssues({
    report: reportWith(findings),
    testMode: false,
    createIssues: true,
    existingReal: [],
    existingTest: [],
    links: LINKS,
    deps,
  });
  assert.equal(plan.items.filter((item) => item.decision === 'create').length, 3);
  assert.equal(plan.items.filter((item) => item.decision === 'limit').length, 1);
});

test('nothing is written when create_issues is false', () => {
  const plan = planIssues({
    report: reportWith([testFinding()]),
    testMode: true,
    createIssues: false,
    existingReal: [],
    existingTest: [],
    links: LINKS,
    deps,
  });
  const proposed = renderProposed(plan);
  assert.match(proposed, /Dry run: `create_issues=false`, so nothing is published/);
  assert.match(proposed, /Would: create a new issue/);
  assert.match(proposed, /lighthouse-test/);
  assert.match(proposed, /\[TEST\]/);

  const decisions = renderDecisions(plan, {
    eventName: 'workflow_dispatch',
    testMode: true,
    appUrl: LINKS.appUrl,
  });
  assert.match(decisions, /test_mode: true/);
  assert.match(decisions, /create_issues: false/);
  assert.match(decisions, /dry-run: proposed, not published/);
  assert.match(decisions, /real findings in test_mode: 0 analysed, 0 published/);
});

test('creation re-checks deduplication and never creates a duplicate', () => {
  const finding = realFinding();
  const plan = planIssues({
    report: reportWith([finding]),
    testMode: false,
    createIssues: true,
    existingReal: [],
    existingTest: [],
    links: LINKS,
    deps,
  });
  assert.equal(plan.items[0].decision, 'create');

  // The issue appeared after the preview read: the create step sees it.
  const { runGh, calls } = fakeGh({ issues: { lighthouse: [issue(11, finding)] } });
  const executed = executePlan({
    plan,
    runGh,
    repo: 'acme/repo',
    links: LINKS,
    testMode: false,
  });

  assert.equal(executed.items[0].decision, 'duplicate_after_preview');
  assert.equal(executed.items[0].duplicate.number, 11);
  assert.equal(
    calls.filter((args) => args[0] === 'issue' && args[1] === 'create').length,
    0,
  );
});

test('creation calls gh with the exact payload once', () => {
  const plan = planIssues({
    report: reportWith([realFinding()]),
    testMode: false,
    createIssues: true,
    existingReal: [],
    existingTest: [],
    links: LINKS,
    deps,
  });
  const { runGh, calls } = fakeGh({ issues: { lighthouse: [] } });
  const executed = executePlan({
    plan,
    runGh,
    repo: 'acme/repo',
    links: LINKS,
    testMode: false,
  });

  assert.equal(executed.items[0].decision, 'created');
  assert.equal(executed.items[0].issueUrl, 'https://github.com/acme/repo/issues/42');
  const create = calls.find((args) => args[1] === 'create');
  assert.ok(create.includes('--label'));
  assert.ok(create.includes('lighthouse'));
  assert.match(renderIssues(executed), /#42/);
  assert.match(summaryLines(executed, { testMode: false, createIssues: true, runUrl: LINKS.runUrl }), /Created #42/);
});

test('creation in test mode labels the synthetic issue lighthouse-test', () => {
  const plan = planIssues({
    report: reportWith([testFinding()]),
    testMode: true,
    createIssues: true,
    existingReal: [],
    existingTest: [],
    links: LINKS,
    deps,
  });
  const { runGh, calls } = fakeGh({ issues: { 'lighthouse-test': [] } });
  const executed = executePlan({
    plan,
    runGh,
    repo: 'acme/repo',
    links: LINKS,
    testMode: true,
  });
  const item = executed.items.find((entry) => entry.kind === 'test');
  assert.equal(item.decision, 'created');

  const create = calls.find((args) => args[1] === 'create');
  const labels = create.flatMap((value, index) =>
    value === '--label' ? [create[index + 1]] : [],
  );
  assert.deepEqual(labels, ['lighthouse-test']);
});

test('the test issue body is deterministic', () => {
  const first = buildTestIssue(testFinding(), {
    ...LINKS,
    createIssues: true,
  });
  const second = buildTestIssue(testFinding(), {
    ...LINKS,
    createIssues: true,
  });
  assert.equal(first.body, second.body);
  assert.equal(first.title, second.title);
});
