import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const RETENTION_DAYS = 90;
export const NOTICE_MARKER = '<!-- opencode-budget-notice -->';
export const RUN_TAG_PREFIX = 'opencode ref-';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PAGES = 10;

export function parseBudget(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new Error(
      `OPENCODE_PR_ATTEMPT_BUDGET must be a non-negative integer, got ${JSON.stringify(value)}`,
    );
  }
  const budget = Number(value);
  if (!Number.isInteger(budget) || budget < 0) {
    throw new Error(
      `OPENCODE_PR_ATTEMPT_BUDGET must be a non-negative integer, got ${JSON.stringify(value)}`,
    );
  }
  return budget;
}

export function isPullRequestEvent(eventName, event) {
  return (
    eventName === 'pull_request_review_comment' ||
    Boolean(event?.issue?.pull_request)
  );
}

export function pullRequestNumber(eventName, event) {
  return eventName === 'pull_request_review_comment'
    ? event?.pull_request?.number
    : event?.issue?.number;
}

export function runTag(number) {
  return `${RUN_TAG_PREFIX}${number}`;
}

export function currentRunTagMatches(runs, currentRunId, tag) {
  const current = (runs ?? []).find(
    (run) => String(run.id) === String(currentRunId),
  );
  return current ? current.display_title === tag : true;
}

export function windowStart(
  pullRequestCreatedAt,
  now = new Date(),
  retentionDays = RETENTION_DAYS,
) {
  const retention = new Date(now.getTime() - retentionDays * DAY_MS);
  const created = pullRequestCreatedAt
    ? new Date(pullRequestCreatedAt)
    : retention;
  const start = Number.isNaN(created.getTime())
    ? retention
    : new Date(Math.max(created.getTime(), retention.getTime()));
  return start.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function countAttempts(
  runs,
  { key, currentRunId, currentAttempt, since } = {},
) {
  const tag = runTag(key);
  const sinceTime = since ? new Date(since).getTime() : null;
  let attempts = 0;

  for (const run of runs ?? []) {
    if (String(run.id) === String(currentRunId)) continue;
    if (run.display_title !== tag) continue;
    if (run.conclusion === 'skipped') continue;
    if (run.status !== 'in_progress' && run.status !== 'completed') continue;
    if (
      sinceTime !== null &&
      new Date(run.created_at).getTime() < sinceTime
    ) {
      continue;
    }

    const runAttempts = Number(run.run_attempt);
    attempts +=
      Number.isInteger(runAttempts) && runAttempts > 0 ? runAttempts : 1;
  }

  const ownAttempts = Math.max(0, (Number(currentAttempt) || 1) - 1);
  return attempts + ownAttempts;
}

export function decide({
  runs,
  key,
  currentRunId,
  currentAttempt,
  budget,
  since,
}) {
  const used = countAttempts(runs, {
    key,
    currentRunId,
    currentAttempt,
    since,
  });

  return {
    allowed: used < budget,
    used,
    attempt: used + 1,
    budget,
  };
}

export function buildNotice({
  status,
  key,
  attempt,
  budget,
  sha,
  runUrl,
  runAttempt,
  commentUrl,
  actor,
}) {
  const exhausted = status === 'limit_exhausted';
  const lines = [
    NOTICE_MARKER,
    exhausted
      ? '## OpenCode attempt limit reached'
      : '## OpenCode attempt budget check failed',
    '',
    `- **Status:** \`${status}\` — needs human (нужен человек)`,
    `- **Pull request:** #${key}`,
  ];

  if (commentUrl) {
    lines.push(
      `- **Trigger:** [comment](${commentUrl})${actor ? ` by @${actor}` : ''}`,
    );
  }

  lines.push(
    `- **Attempt:** ${attempt ?? 'unknown'} of ${budget}`,
    `- **Commit:** \`${sha ?? 'unknown'}\``,
    `- **Workflow run:** [logs](${runUrl}) (attempt ${runAttempt})`,
    '- **Budget source:** GitHub Actions run history for `.github/workflows/opencode.yml`',
    '',
    exhausted
      ? 'The model was not called for this attempt. The limit is per pull request and is derived from Actions history; comments cannot reset it.'
      : 'The budget check failed, so the model was not called. A human must investigate before retrying.',
  );

  return lines.join('\n');
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
}

function writeSummary(lines) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  }
}

function nextPage(linkHeader) {
  if (!linkHeader) return null;
  const match = /<([^>]+)>;\s*rel="next"/.exec(linkHeader);
  return match?.[1] ?? null;
}

async function request(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'opencode-budget',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
  });

  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    throw new Error(
      `${options.method ?? 'GET'} ${url} failed with ${response.status}: ${body}`,
    );
  }

  const body = await response.text();
  return {
    json: body ? JSON.parse(body) : null,
    headers: response.headers,
  };
}

async function loadPullRequest({ apiUrl, repo, token, key, context }) {
  if (context.sha && context.prCreatedAt) return context;

  const { json } = await request(
    `${apiUrl}/repos/${repo}/pulls/${key}`,
    token,
  );

  return {
    ...context,
    sha: context.sha ?? json.head?.sha ?? null,
    prCreatedAt: context.prCreatedAt ?? json.created_at ?? null,
  };
}

async function listWorkflowRuns({ apiUrl, repo, token, since }) {
  const params = new URLSearchParams({
    per_page: '100',
    created: `>=${since}`,
  });
  let url = `${apiUrl}/repos/${repo}/actions/workflows/opencode.yml/runs?${params}`;
  const runs = [];

  for (let page = 0; url; page += 1) {
    if (page >= MAX_PAGES) {
      throw new Error(
        `Workflow run history exceeds ${MAX_PAGES * 100} entries; refusing to guess the budget`,
      );
    }

    const { json, headers } = await request(url, token);
    runs.push(...(json.workflow_runs ?? []));
    url = nextPage(headers.get('link'));
  }

  return runs;
}

async function publishNotice({ apiUrl, repo, token, key, body }) {
  let existing = null;
  let url = `${apiUrl}/repos/${repo}/issues/${key}/comments?per_page=100`;

  for (let page = 0; url; page += 1) {
    if (page >= MAX_PAGES) break;

    const { json, headers } = await request(url, token);
    existing = (json ?? []).find(
      (comment) =>
        comment.user?.login === 'github-actions[bot]' &&
        comment.body?.includes(NOTICE_MARKER),
    );
    if (existing) break;
    url = nextPage(headers.get('link'));
  }

  if (existing) {
    try {
      await request(`${apiUrl}/repos/${repo}/issues/comments/${existing.id}`, token, {
        method: 'PATCH',
        body: JSON.stringify({ body }),
      });
      return;
    } catch (error) {
      console.error(`Could not update the budget notice: ${error.message}`);
    }
  }

  await request(`${apiUrl}/repos/${repo}/issues/${key}/comments`, token, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}

function readEvent() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error('GITHUB_EVENT_PATH is missing');
  return JSON.parse(readFileSync(eventPath, 'utf8'));
}

function contextFromEvent(eventName, event) {
  const comment = event?.comment ?? {};
  return {
    eventName,
    isPR: isPullRequestEvent(eventName, event),
    key: pullRequestNumber(eventName, event),
    sha: event?.pull_request?.head?.sha ?? null,
    prCreatedAt: event?.pull_request?.created_at ?? null,
    commentUrl: comment.html_url ?? null,
    actor: comment.user?.login ?? null,
  };
}

async function main() {
  const token = process.env.GH_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  const runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT) || 1;
  const serverUrl = (process.env.GITHUB_SERVER_URL || 'https://github.com').replace(
    /\/$/,
    '',
  );
  const apiUrl = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(
    /\/$/,
    '',
  );
  const runUrl = `${serverUrl}/${repo}/actions/runs/${runId}`;
  let context;

  try {
    context = contextFromEvent(
      process.env.GITHUB_EVENT_NAME,
      readEvent(),
    );

    if (!context.isPR) {
      setOutput('allowed', 'true');
      setOutput('decision', 'not_a_pull_request');
      console.log(
        `Not a pull request (${context.eventName}); the attempt budget is not applied.`,
      );
      return;
    }

    if (!repo || !runId) {
      throw new Error('GITHUB_REPOSITORY or GITHUB_RUN_ID is missing');
    }
    if (!context.key) throw new Error('The pull request number is missing');
    if (!token) throw new Error('GH_TOKEN is missing');

    const budget = parseBudget(process.env.OPENCODE_PR_ATTEMPT_BUDGET);
    const pullRequest = await loadPullRequest({
      apiUrl,
      repo,
      token,
      key: context.key,
      context,
    });
    const since = windowStart(pullRequest.prCreatedAt);
    const runs = await listWorkflowRuns({ apiUrl, repo, token, since });
    const tag = runTag(context.key);
    if (!currentRunTagMatches(runs, runId, tag)) {
      const current = runs.find((run) => String(run.id) === String(runId));
      throw new Error(
        `The current run is tagged "${current?.display_title}", expected "${tag}". Check the workflow run-name.`,
      );
    }
    const decision = decide({
      runs,
      key: context.key,
      currentRunId: runId,
      currentAttempt: runAttempt,
      budget,
      since,
    });

    console.log(
      `Attempt budget for ${tag}: ${decision.used} attempt(s) before this run, ${runs.length} run(s) scanned since ${since}.`,
    );

    setOutput('allowed', String(decision.allowed));
    setOutput('decision', decision.allowed ? 'allowed' : 'limit_exhausted');
    setOutput('used', decision.used);
    setOutput('budget', decision.budget);
    setOutput('attempt', decision.attempt);
    setOutput('sha', pullRequest.sha ?? 'unknown');

    writeSummary([
      '### OpenCode attempt budget',
      '',
      `- Pull request: #${context.key}`,
      `- Attempt: ${decision.attempt} of ${decision.budget}`,
      `- Attempts counted before this one: ${decision.used}`,
      `- Runs scanned: ${runs.length} (since ${since})`,
      `- Decision: \`${decision.allowed ? 'allowed' : 'limit_exhausted'}\``,
      `- Source: Actions run history for \`${tag}\``,
    ]);

    if (decision.allowed) {
      console.log(
        `Attempt ${decision.attempt} of ${decision.budget} is allowed.`,
      );
      return;
    }

    const body = buildNotice({
      status: 'limit_exhausted',
      key: context.key,
      attempt: decision.attempt,
      budget: decision.budget,
      sha: pullRequest.sha,
      runUrl,
      runAttempt,
      commentUrl: context.commentUrl,
      actor: context.actor,
    });

    await publishNotice({
      apiUrl,
      repo,
      token,
      key: context.key,
      body,
    });
    console.error(
      `Attempt ${decision.attempt} of ${decision.budget} is blocked; no model call was made.`,
    );
    process.exitCode = 1;
  } catch (error) {
    console.error(error);

    setOutput('allowed', 'false');
    setOutput('decision', 'budget_check_error');

    writeSummary([
      '### OpenCode attempt budget check failed',
      '',
      '- Decision: `budget_check_error`',
      '- No model call was made.',
      '',
      `\`\`\`\n${error.message}\n\`\`\``,
    ]);

    if (context?.isPR && context.key && token && repo) {
      try {
        await publishNotice({
          apiUrl,
          repo,
          token,
          key: context.key,
          body: buildNotice({
            status: 'budget_check_error',
            key: context.key,
            attempt: null,
            budget: process.env.OPENCODE_PR_ATTEMPT_BUDGET ?? 'unknown',
            sha: context.sha,
            runUrl,
            runAttempt,
            commentUrl: context.commentUrl,
            actor: context.actor,
          }),
        });
      } catch (publishError) {
        console.error(
          `Could not publish the budget error notice: ${publishError.message}`,
        );
      }
    }

    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
