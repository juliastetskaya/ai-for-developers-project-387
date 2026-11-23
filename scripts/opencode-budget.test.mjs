import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  NOTICE_MARKER,
  buildNotice,
  countAttempts,
  currentRunTagMatches,
  decide,
  isPullRequestEvent,
  parseBudget,
  pullRequestNumber,
  runTag,
  windowStart,
} from './opencode-budget.mjs';

const SINCE = '2026-11-20T00:00:00Z';

function run(overrides = {}) {
  return {
    id: 1,
    display_title: runTag(42),
    status: 'completed',
    conclusion: 'success',
    run_attempt: 1,
    created_at: '2026-11-23T10:00:00Z',
    ...overrides,
  };
}

function options(overrides = {}) {
  return {
    key: 42,
    currentRunId: 999,
    currentAttempt: 1,
    budget: 3,
    since: SINCE,
    ...overrides,
  };
}

describe('parseBudget', () => {
  test('accepts a non-negative integer', () => {
    assert.equal(parseBudget('3'), 3);
    assert.equal(parseBudget(0), 0);
  });

  test('rejects anything else', () => {
    for (const value of [undefined, '', '-1', '2.5', 'many']) {
      assert.throws(() => parseBudget(value), /non-negative integer/);
    }
  });
});

describe('event helpers', () => {
  test('recognises a PR conversation comment', () => {
    const event = { issue: { number: 12, pull_request: {} } };
    assert.equal(isPullRequestEvent('issue_comment', event), true);
    assert.equal(pullRequestNumber('issue_comment', event), 12);
  });

  test('recognises a plain issue comment', () => {
    const event = { issue: { number: 12 } };
    assert.equal(isPullRequestEvent('issue_comment', event), false);
    assert.equal(pullRequestNumber('issue_comment', event), 12);
  });

  test('recognises a review comment', () => {
    const event = { pull_request: { number: 13 } };
    assert.equal(isPullRequestEvent('pull_request_review_comment', event), true);
    assert.equal(pullRequestNumber('pull_request_review_comment', event), 13);
  });
});

describe('runTag', () => {
  test('uses the same prefix as the workflow run-name', () => {
    assert.equal(runTag(42), 'opencode ref-42');
  });
});

describe('currentRunTagMatches', () => {
  test('accepts a missing current run (the API can lag)', () => {
    assert.equal(currentRunTagMatches([run({ id: 1 })], 999, runTag(42)), true);
  });

  test('accepts the current run when the tag matches', () => {
    assert.equal(
      currentRunTagMatches([run({ id: 999 })], 999, runTag(42)),
      true,
    );
  });

  test('rejects a mismatched tag so a broken run-name fails closed', () => {
    assert.equal(
      currentRunTagMatches(
        [run({ id: 999, display_title: 'Some pull request title' })],
        999,
        runTag(42),
      ),
      false,
    );
  });
});

describe('windowStart', () => {
  const now = new Date('2026-11-23T00:00:00Z');

  test('starts at the PR creation when it is inside the retention window', () => {
    assert.equal(
      windowStart('2026-11-22T00:00:00Z', now),
      '2026-11-22T00:00:00Z',
    );
  });

  test('falls back to the retention boundary for older PRs', () => {
    assert.equal(
      windowStart('2020-01-01T00:00:00Z', now),
      '2026-08-25T00:00:00Z',
    );
  });

  test('falls back to the retention boundary for a missing date', () => {
    assert.equal(windowStart(null, now), '2026-08-25T00:00:00Z');
  });
});

describe('countAttempts', () => {
  test('an empty history uses no attempts', () => {
    assert.equal(countAttempts([], options()), 0);
  });

  test('counts a completed run for the same PR', () => {
    assert.equal(countAttempts([run()], options()), 1);
  });

  test('ignores the current run', () => {
    assert.equal(countAttempts([run({ id: 999 })], options()), 0);
  });

  test('counts the previous attempts of the current run', () => {
    assert.equal(
      countAttempts([], options({ currentAttempt: 2 })),
      1,
    );
  });

  test('counts every attempt of a re-run run', () => {
    assert.equal(
      countAttempts([run({ run_attempt: 3 })], options()),
      3,
    );
  });

  test('counts cancelled and timed-out runs', () => {
    assert.equal(
      countAttempts(
        [
          run({ id: 1, conclusion: 'cancelled' }),
          run({ id: 2, conclusion: 'timed_out' }),
          run({ id: 3, conclusion: 'failure' }),
        ],
        options(),
      ),
      3,
    );
  });

  test('counts an in-progress run so parallel attempts see each other', () => {
    assert.equal(
      countAttempts(
        [run({ status: 'in_progress', conclusion: null })],
        options(),
      ),
      1,
    );
  });

  test('ignores queued runs until they start', () => {
    for (const status of ['queued', 'pending', 'waiting', 'requested']) {
      assert.equal(
        countAttempts(
          [run({ status, conclusion: null })],
          options(),
        ),
        0,
      );
    }
  });

  test('ignores skipped runs (bots, untrusted users, no command)', () => {
    assert.equal(
      countAttempts(
        [run({ status: 'completed', conclusion: 'skipped' })],
        options(),
      ),
      0,
    );
  });

  test('ignores runs tagged for another PR or for an issue', () => {
    assert.equal(
      countAttempts(
        [
          run({ display_title: runTag(41) }),
          run({ display_title: 'opencode ref-420' }),
          run({ display_title: 'Some pull request title' }),
        ],
        options(),
      ),
      0,
    );
  });

  test('ignores runs older than the window', () => {
    assert.equal(
      countAttempts(
        [run({ created_at: '2026-11-19T23:59:59Z' })],
        options(),
      ),
      0,
    );
  });

  test('includes a run exactly at the window boundary', () => {
    assert.equal(
      countAttempts([run({ created_at: SINCE })], options()),
      1,
    );
  });

  test('treats a malformed run_attempt as one attempt', () => {
    for (const runAttempt of [undefined, null, 0, -2, 'nope']) {
      assert.equal(
        countAttempts([run({ run_attempt: runAttempt })], options()),
        1,
      );
    }
  });
});

describe('decide', () => {
  test('allows attempts below the budget', () => {
    const decision = decide({ ...options(), runs: [run(), run({ id: 2 })] });
    assert.deepEqual(decision, {
      allowed: true,
      used: 2,
      attempt: 3,
      budget: 3,
    });
  });

  test('allows when the next attempt is exactly the budget', () => {
    const decision = decide({ ...options({ budget: 2 }), runs: [run()] });
    assert.equal(decision.allowed, true);
    assert.equal(decision.used, 1);
    assert.equal(decision.attempt, 2);
  });

  test('blocks when the budget is already used', () => {
    const decision = decide({
      ...options(),
      runs: [run({ id: 1 }), run({ id: 2 }), run({ id: 3 })],
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.used, 3);
    assert.equal(decision.attempt, 4);
  });

  test('a budget of zero blocks every attempt', () => {
    const decision = decide({ ...options({ budget: 0 }), runs: [] });
    assert.equal(decision.allowed, false);
    assert.equal(decision.attempt, 1);
  });

  test('a re-run of the current run cannot bypass a full budget', () => {
    const decision = decide({
      ...options({ budget: 2, currentRunId: 1, currentAttempt: 2 }),
      runs: [run({ id: 1 }), run({ id: 2 })],
    });
    assert.equal(decision.used, 2);
    assert.equal(decision.allowed, false);
  });

  test('does not mutate the runs it is given', () => {
    const runs = [run(), run({ id: 2, run_attempt: 2 })];
    const snapshot = structuredClone(runs);
    decide({ ...options(), runs });
    assert.deepEqual(runs, snapshot);
  });
});

describe('buildNotice', () => {
  const notice = buildNotice({
    status: 'limit_exhausted',
    key: 42,
    attempt: 4,
    budget: 3,
    sha: '0123456789abcdef0123456789abcdef01234567',
    runUrl: 'https://github.com/owner/repo/actions/runs/123',
    runAttempt: 1,
    commentUrl: 'https://github.com/owner/repo/pull/42#issuecomment-1',
    actor: 'alice',
  });

  test('is a sticky notice with the exhaustion status', () => {
    assert.ok(notice.startsWith(NOTICE_MARKER));
    assert.match(notice, /`limit_exhausted`/);
    assert.match(notice, /needs human/);
    assert.match(notice, /нужен человек/);
  });

  test('contains the attempt, SHA, run link and trigger', () => {
    assert.match(notice, /Attempt:\*\* 4 of 3/);
    assert.match(notice, /0123456789abcdef/);
    assert.match(notice, /actions\/runs\/123/);
    assert.match(notice, /issuecomment-1/);
    assert.match(notice, /@alice/);
  });

  test('describes a failed budget check without claiming exhaustion', () => {
    const failed = buildNotice({
      status: 'budget_check_error',
      key: 42,
      attempt: null,
      budget: 3,
      sha: null,
      runUrl: 'https://github.com/owner/repo/actions/runs/123',
      runAttempt: 2,
    });
    assert.match(failed, /`budget_check_error`/);
    assert.match(failed, /Attempt:\*\* unknown of 3/);
    assert.match(failed, /Commit:\*\* `unknown`/);
    assert.doesNotMatch(failed, /limit_exhausted/);
  });
});
