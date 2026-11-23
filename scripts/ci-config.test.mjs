import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(root, path), 'utf8');

function miseTask(name) {
  const lines = read('mise.toml').split('\n');
  const header = new RegExp(`^\\[tasks\\.(?:"${name}"|${name})\\]\\s*$`);
  const start = lines.findIndex((line) => header.test(line));
  assert.notEqual(start, -1, `mise task "${name}" is missing`);

  let end = lines.findIndex(
    (line, index) => index > start && line.startsWith('['),
  );
  if (end === -1) end = lines.length;
  return lines.slice(start + 1, end).join('\n');
}

function miseDepends(task) {
  const section = miseTask(task);
  const match = section.match(/depends\s*=\s*\[([^\]]*)\]/s);
  assert.ok(match, `mise task "${task}" has no depends list`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

test('mise check runs every gate sequentially: lint, SDK freshness, typecheck, unit+e2e tests, build', () => {
  const section = miseTask('check');
  assert.doesNotMatch(
    section,
    /^\s*depends\s*=/m,
    'check must run its gates sequentially: check:sdk regenerates the SDK in place',
  );
  for (const gate of [
    'lint',
    'check:sdk',
    'typecheck',
    'test',
    'e2e:golden',
    'build',
  ]) {
    assert.ok(
      section.includes(`mise run ${gate}`),
      `mise check must run "${gate}"`,
    );
  }
});

test('CI installs Playwright before running the shared check gate', () => {
  const workflow = read('.github/workflows/check.yml');
  assert.match(workflow, /playwright install --with-deps chromium/);
});

test('CI builds the production Docker image in a separate pull-request job', () => {
  const workflow = read('.github/workflows/check.yml');
  const start = workflow.search(/^ {2}docker:/m);
  assert.notEqual(start, -1, 'check.yml must define a separate "docker" job');

  const dockerJob = workflow.slice(start);
  assert.match(
    dockerJob,
    /if:\s*github\.event_name == 'pull_request'/,
    'the docker job must run on pull requests only',
  );
  assert.match(dockerJob, /run: mise run docker:build/);
  assert.doesNotMatch(
    dockerJob,
    /run: mise run setup/,
    'the docker job builds inside the image, so it must not install workspace dependencies',
  );
});

test('mise test includes backend e2e tests', () => {
  assert.match(miseTask('test'), /test:e2e/);
});

test('build waits for typecheck so two tsc processes do not write the same build info', () => {
  assert.ok(miseDepends('build').includes('typecheck'));
});

test('root scripts expose an independent backend e2e command', () => {
  const scripts = JSON.parse(read('package.json')).scripts;
  assert.match(scripts['test:e2e'] ?? '', /--filter backend test:e2e/);
});

test('CI workflow runs setup and the shared check gate on push and pull_request', () => {
  const workflow = read('.github/workflows/check.yml');
  assert.match(workflow, /^on:/m);
  assert.match(workflow, /^ {2}push:/m);
  assert.match(workflow, /^ {2}pull_request:/m);
  assert.match(workflow, /run: mise run setup/);
  assert.match(workflow, /run: mise run check/);
});

test('CI workflow does not depend on repository secrets (fork-safe)', () => {
  const workflow = read('.github/workflows/check.yml');
  assert.doesNotMatch(workflow, /secrets\./);
});

test('lint and typecheck gates also cover the golden path and repo scripts', () => {
  const scripts = JSON.parse(read('package.json')).scripts;

  assert.match(scripts.lint ?? '', /pnpm lint:e2e/);
  assert.match(scripts.typecheck ?? '', /pnpm typecheck:e2e/);
  assert.match(scripts['lint:e2e'] ?? '', /oxlint/);
  assert.match(scripts['lint:e2e'] ?? '', /e2e/);
  assert.match(scripts['lint:e2e'] ?? '', /scripts/);
  assert.match(scripts['typecheck:e2e'] ?? '', /tsconfig\.e2e\.json/);
});

test('the comment-driven opencode workflow is pinned, time-limited and serialized per task', () => {
  const workflow = read('.github/workflows/opencode.yml');

  const uses = workflow.split('\n').filter((line) => /^\s*uses:/.test(line));
  assert.ok(uses.length >= 2, 'opencode.yml must check out the repo and run the action');
  for (const line of uses) {
    assert.match(
      line,
      /@[0-9a-f]{40}\s+#\s*v?\d+\.\d+\.\d+/,
      `every action must be pinned to a full commit SHA with its release in a comment: ${line.trim()}`,
    );
  }

  assert.match(workflow, /^\s+timeout-minutes:\s*\d+$/m);
  assert.match(
    workflow,
    /^\s+model:\s*[a-z]+\/[a-z0-9.-]+$/m,
    'the model must be a provider/model pair',
  );
  assert.match(workflow, /^\s+variant:\s*(low|high|max)$/m, 'the run pins a model variant');
  assert.match(
    workflow,
    /group: opencode-\$\{\{\s*github\.event\.issue\.number\s*\|\|\s*github\.event\.pull_request\.number\s*\}\}/,
    'runs on one task must share a concurrency group',
  );
  assert.match(workflow, /cancel-in-progress:\s*false/);
  assert.match(workflow, /permissions:\n\s+contents: read\n\s+id-token: write/);
  assert.doesNotMatch(
    workflow,
    /(contents|pull-requests|issues):\s*write/,
    'write permissions must come from the OpenCode App token, not the workflow',
  );
  assert.match(
    workflow,
    /contains\(fromJSON\('\["OWNER","MEMBER","COLLABORATOR"\]'\), github\.event\.comment\.author_association\)/,
    'a public repo must not let strangers spend the API key',
  );
  assert.match(
    workflow,
    /github\.event\.comment\.user\.type\s*!=\s*'Bot'/,
    'commands from bots must be ignored',
  );
  assert.match(
    workflow,
    /persist-credentials:\s*false/,
    'checkout must not leave the GITHUB_TOKEN in git config',
  );
  assert.match(
    workflow,
    /mentions:\s*\/oc,\/opencode/,
    'the accepted trigger phrases must be explicit',
  );
  assert.match(
    workflow,
    /SHARE:\s*['"]false['"]/,
    'session sharing must be explicitly disabled',
  );
});

test('automatic issue triage runs only for trusted humans on unprepared issues', () => {
  const workflow = read('.github/workflows/issue-triage.yml');

  assert.match(workflow, /^name:\s*issue-triage$/m);
  assert.match(workflow, /^on:\n\s+issues:\n\s+types:\s*\[opened\]$/m);

  const uses = workflow.split('\n').filter((line) => /^\s*uses:/.test(line));
  assert.ok(uses.length >= 2, 'issue-triage.yml must check out the repo and run the action');
  for (const line of uses) {
    assert.match(
      line,
      /@[0-9a-f]{40}\s+#\s*v?\d+\.\d+\.\d+/,
      `every action must be pinned to a full commit SHA with its release in a comment: ${line.trim()}`,
    );
  }

  assert.match(
    workflow,
    /github\.event\.issue\.user\.type\s*!=\s*'Bot'/,
    'issues opened by bots must be ignored',
  );
  assert.match(
    workflow,
    /contains\(fromJSON\('\["OWNER","MEMBER","COLLABORATOR"\]'\), github\.event\.issue\.author_association\)/,
    'only trusted repository participants may spend the API key',
  );
  assert.match(
    workflow,
    /!contains\(github\.event\.issue\.labels\.\*\.name, 'ready-for-agent'\)/,
    'issues already prepared by a skill must be skipped',
  );

  assert.match(workflow, /^\s+timeout-minutes:\s*15$/m);
  assert.match(
    workflow,
    /group:\s*issue-triage-\$\{\{\s*github\.event\.issue\.number\s*\}\}/,
    'runs for one issue must share a dedicated concurrency group',
  );
  assert.match(workflow, /cancel-in-progress:\s*false/);

  assert.match(workflow, /permissions:\n\s+contents: read\n\s+id-token: write/);
  assert.doesNotMatch(
    workflow,
    /^\s+issues: read$/m,
    'no issue comment reads are needed without the duplicate guard',
  );
  assert.doesNotMatch(
    workflow,
    /gh api .*issues\/\$ISSUE\/comments|steps\.existing\.outputs\.found/,
    'the duplicate-report check is redundant: the workflow only runs on opened issues',
  );
  assert.doesNotMatch(
    workflow,
    /(contents|pull-requests|issues):\s*write/,
    'write access must come from the OpenCode App token, not the workflow',
  );
  assert.match(
    workflow,
    /persist-credentials:\s*false/,
    'checkout must not leave the GITHUB_TOKEN in git config',
  );

  assert.match(
    workflow,
    /prompt:\s*\|/,
    'the issues event requires a custom prompt',
  );
  assert.match(
    workflow,
    /<!-- issue-triage-report -->/,
    'the report must carry its marker so the comment is recognisable',
  );
  assert.match(workflow, /SHARE:\s*['"]false['"]/);
  assert.match(
    workflow,
    /OPENCODE_PERMISSION:\s*\|\n\s+\{\n\s+"external_directory": "deny",\n\s+"edit": "deny"\n\s+\}/,
    'the permission object must be passed as JSON to the OpenCode step',
  );
});

test('release-please prefers a PAT and falls back to GITHUB_TOKEN', () => {
  const workflow = read('.github/workflows/release-please.yml');

  assert.match(
    workflow,
    /token:\s*\$\{\{\s*secrets\.RELEASE_PLEASE_TOKEN\s*\|\|\s*secrets\.GITHUB_TOKEN\s*\}\}/,
  );
});

test('independent AI review runs on eligible pull requests only', () => {
  const workflow = read('.github/workflows/review.yml');

  assert.match(workflow, /^name:\s*ai-review$/m);
  assert.match(
    workflow,
    /^on:\n {2}pull_request:\n {4}types:\s*\[opened, synchronize, reopened, ready_for_review, edited\]$/m,
  );
  assert.doesNotMatch(workflow, /pull_request_target/);

  assert.match(workflow, /github\.event\.pull_request\.draft\s*==\s*false/);
  assert.match(
    workflow,
    /github\.event\.pull_request\.head\.repo\.full_name\s*==\s*github\.repository/,
    'fork pull requests must be skipped before any secret is used',
  );
  assert.match(workflow, /github\.event\.pull_request\.author_association/, 'only trusted authors may spend the API key');
  assert.match(workflow, /opencode-agent\[bot\]/, 'the repository agent bot is explicitly allowed');
  assert.match(workflow, /github\.event\.action != 'edited'/, 'body edits must not trigger a needless rerun');

  const uses = workflow.split('\n').filter((line) => /^\s*uses:/.test(line));
  assert.ok(uses.length >= 3, 'review.yml must check out, hand off and publish the report');
  for (const line of uses) {
    assert.match(
      line,
      /@[0-9a-f]{40}\s+#\s*v?\d+\.\d+\.\d+/,
      `every action must be pinned to a full commit SHA with its release in a comment: ${line.trim()}`,
    );
  }
});

test('independent AI review pins OpenCode CLI 1.19.6 and a read-only permission set', () => {
  const workflow = read('.github/workflows/review.yml');

  assert.match(workflow, /VERSION:\s*1\.19\.6/);
  assert.match(workflow, /opencode\/bin\/opencode" --version \| grep -Fx "1\.19\.6"/);
  assert.doesNotMatch(workflow, /v2\/install|@opencode\/cli|opencode\/github@/);
  assert.match(workflow, /--model opencode\/deepseek-v4\.1-flash/);
  assert.match(workflow, /--variant low/);

  const permissionText = workflow.match(/OPENCODE_PERMISSION:\s*\|\n([\s\S]*?)\n\s{8}run:/)?.[1];
  assert.ok(permissionText, 'review.yml must pass OPENCODE_PERMISSION as JSON');
  const permission = JSON.parse(permissionText);

  assert.equal(permission['*'], 'deny', 'never use permissive defaults');
  for (const tool of [
    'bash',
    'edit',
    'task',
    'webfetch',
    'websearch',
    'skill',
    'lsp',
    'todowrite',
    'question',
    'external_directory',
    'doom_loop',
  ]) {
    assert.equal(permission[tool], 'deny', `the reviewer must not use ${tool}`);
  }
  for (const tool of ['glob', 'grep', 'list']) {
    assert.equal(permission[tool], 'allow', `the reviewer needs ${tool} for local analysis`);
  }
  assert.equal(permission.read['*'], 'allow');
  assert.equal(permission.read['*.env'], 'deny');
  assert.match(
    workflow,
    /OPENCODE_DISABLE_PROJECT_CONFIG:\s*['"]1['"]/,
    'the repository MCP servers must not be loaded into the reviewer',
  );
  assert.match(
    workflow,
    /OPENCODE_DISABLE_CLAUDE_CODE:\s*['"]1['"]/,
    'Claude instruction files and skills must not be loaded',
  );
  assert.match(
    workflow,
    /OPENCODE_PURE:\s*['"]1['"]/,
    'external plugins must not be loaded into the reviewer',
  );

  const reviewStep = workflow.slice(
    workflow.indexOf('- name: Run independent AI review'),
    workflow.indexOf('- name: Upload the review report'),
  );
  assert.doesNotMatch(
    reviewStep,
    /^\s+(GH_TOKEN|GITHUB_TOKEN):|github\.token|secrets\.GITHUB_TOKEN/m,
    'the OpenCode process must not receive a GitHub token',
  );
});

test('independent AI review separates execution from idempotent comment publication', () => {
  const workflow = read('.github/workflows/review.yml');
  const [reviewJob, publishJob] = workflow.split(/\n {2}publish:\n/);
  assert.ok(reviewJob && publishJob, 'review.yml must define separate review and publish jobs');

  assert.match(reviewJob, /^permissions:\s*\{\}$/m);
  assert.match(
    reviewJob,
    /permissions:\n\s+contents: read\n\s+issues: read\n\s+pull-requests: read\n\s+actions: read\n\s+checks: read\n\s+statuses: read/,
  );
  assert.doesNotMatch(reviewJob, /(contents|pull-requests|issues|actions|checks|statuses):\s*write/);

  assert.match(publishJob, /needs:\s*review/);
  assert.match(publishJob, /permissions:\n\s+pull-requests: write/);
  assert.doesNotMatch(
    publishJob,
    /(contents|issues|checks):\s*write/,
    'publication needs only the pull request comment permission',
  );

  assert.match(workflow, /uses: actions\/upload-artifact@/);
  assert.match(workflow, /uses: actions\/download-artifact@/);
  assert.match(workflow, /<!-- ai-review-report -->/);
  assert.match(workflow, /GITHUB_STEP_SUMMARY/, 'the brief result must also be written to the step summary');
  assert.match(workflow, /### Publication/, 'the publish job must summarise the comment publication');
  assert.match(
    workflow,
    /actions\/runs\/\$\{\{\s*github\.run_id\s*\}\}/,
    'the comment must link to the exact Actions run',
  );
  assert.match(
    workflow,
    /Reviewed commit `%s`\. \[Workflow run\]\(%s\)/,
    'the published comment header must include the run link',
  );
  assert.match(workflow, /closingIssuesReferences/);
  assert.match(workflow, /pr-description/, 'issue references from the PR description must be collected');
  assert.match(workflow, /External issue/, 'external issue references must be marked explicitly');
  assert.match(workflow, /Context unavailable/, 'unreadable external issues must be marked unavailable');
  assert.match(workflow, /gh issue view/, 'available issue context must be fetched');
  assert.match(workflow, /fail_review/, 'missing base criteria must fail before the model runs');
  assert.match(workflow, /Required base-branch file REVIEW\.md/);
  assert.match(workflow, /Required base-branch file AGENTS\.md/);
  assert.doesNotMatch(
    workflow,
    /\|\|\s*cp (REVIEW|AGENTS)\.md/,
    'REVIEW.md and AGENTS.md must never fall back to the PR head',
  );
  assert.match(workflow, /AGENTS\.md\|CLAUDE\.md\|CONTEXT\.md\|REVIEW\.md/, 'head criteria copies must be removed');
  assert.match(workflow, /gh api --method PATCH .*issues\/comments/);
  assert.match(workflow, /gh api --method POST .*issues\/\$PR_NUMBER\/comments/);
  assert.match(workflow, /jq -R -s -r /, 'the JSON event stream must be decoded to raw Markdown');
  assert.match(workflow, /git ls-files -s -z/, 'tracked symlinks must be dropped from the untrusted checkout');
  assert.match(workflow, /git show "\$BASE_SHA:REVIEW\.md"/, 'criteria must come from the base branch');
  assert.match(workflow, /unset GITHUB_TOKEN GH_TOKEN/);
  assert.match(
    workflow,
    /Reviewed commit `%s`/,
    'the published comment must identify the exact reviewed commit',
  );

  assert.doesNotMatch(workflow, /gh pr review|REQUEST_CHANGES|\bAPPROVE\b|gh pr merge/);
  assert.doesNotMatch(
    workflow,
    /mise run (check|test|lint|build|e2e)/,
    'the reviewer must not rerun project CI',
  );
});

test('the AI review contract and pull request template are documented', () => {
  const review = read('REVIEW.md');
  for (const heading of [
    '## What to review',
    '## Severity levels',
    '## Report format',
    '## Boundaries',
  ]) {
    assert.ok(review.includes(heading), `REVIEW.md must contain "${heading}"`);
  }
  for (const severity of ['Critical', 'High', 'Medium', 'Low']) {
    assert.match(review, new RegExp(`\\*\\*${severity}\\*\\*`), `REVIEW.md must define ${severity}`);
  }
  assert.match(review, /general comment only/i);
  assert.match(review, /not a required merge check/i);

  const template = read('.github/pull_request_template.md');
  for (const heading of ['## Context', '## Tests', '## Risk', '## Rollback']) {
    assert.ok(template.includes(heading), `pull request template must contain "${heading}"`);
  }

  assert.match(read('docs/ci.md'), /\.github\/workflows\/review\.yml/);
});
