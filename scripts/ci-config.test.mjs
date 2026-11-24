import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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

function workflowJob(workflow, name) {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.notEqual(start, -1, `the workflow must define a "${name}" job`);

  let end = lines.findIndex(
    (line, index) => index > start && /^ {2}[a-z][\w-]*:$/.test(line),
  );
  if (end === -1) end = lines.length;
  return lines.slice(start, end).join('\n');
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

test('CI verifies the PR head SHA and uploads browser evidence', () => {
  const workflow = read('.github/workflows/check.yml');
  const job = workflowJob(workflow, 'head-browser-evidence');
  assert.match(
    job,
    /if:\s*github\.event_name == 'pull_request'/,
    'the evidence job must run on pull requests only',
  );
  assert.match(
    job,
    /ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\}\}/,
    'the evidence job must check out the author head, not the merge commit',
  );
  assert.match(
    job,
    /persist-credentials:\s*false/,
    'checkout must not leave the GITHUB_TOKEN in git config',
  );
  assert.match(job, /git rev-parse HEAD/, 'the actual checked-out SHA must be recorded');
  assert.match(job, /--trace on/, 'successful runs must record a Playwright trace');
  assert.match(job, /e2e\/booking-delete\.spec\.ts/);
  assert.match(job, /e2e\/golden-path\.spec\.ts/);
  assert.match(
    job,
    /PLAYWRIGHT_JSON_OUTPUT_FILE:\s*\$\{\{\s*runner\.temp\s*\}\}\/head-browser\/results\.json/,
    'the JSON reporter must write into the artifact directory',
  );
  assert.match(
    job,
    /test -s "\$RUNNER_TEMP\/head-browser\/results\.json"/,
    'the evidence job must fail when the JSON result is missing',
  );
  assert.match(job, /uses: actions\/upload-artifact@/);
  assert.match(job, /if:\s*always\(\)/, 'evidence must upload even when a scenario fails');
  assert.match(
    job,
    /name:\s*head-browser-\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\}\}/,
    'the artifact name must carry the head SHA',
  );
  assert.match(job, /if-no-files-found:\s*error/);
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

  const budgetJob = workflowJob(workflow, 'budget');
  const opencodeJob = workflowJob(workflow, 'opencode');
  assert.match(
    budgetJob,
    /permissions:\n\s+contents: read\n(?:\s+#[^\n]*\n)*\s+actions: read\n(?:\s+#[^\n]*\n)*\s+pull-requests: write/,
    'the gate needs run history and one comment',
  );
  assert.match(
    opencodeJob,
    /permissions:\n\s+contents: read\n(?:\s+#[^\n]*\n)*\s+id-token: write/,
    'the model job reads code and mints the App token over OIDC',
  );
  assert.doesNotMatch(
    opencodeJob,
    /(contents|issues|actions|pull-requests):\s*write/,
    'the model job must not hold a write-scoped workflow token',
  );
  assert.doesNotMatch(workflow, /contents:\s*write/);
  assert.doesNotMatch(
    workflow,
    /issues:\s*write/,
    'the budget notice only comments on pull requests',
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

test('the opencode attempt budget is checked before the model and derived from tagged runs', () => {
  const workflow = read('.github/workflows/opencode.yml');

  assert.match(
    workflow,
    /^run-name:\s*["']opencode ref-\$\{\{\s*github\.event\.issue\.number\s*\|\|\s*github\.event\.pull_request\.number\s*\}\}["']$/m,
    'run-name must tag every run with the issue/PR number',
  );
  assert.doesNotMatch(
    workflow.slice(workflow.indexOf('run-name:'), workflow.indexOf('\non:')),
    /comment\.body/,
    'the run name must not interpolate user input',
  );

  const budgetDefinitions = workflow.match(/OPENCODE_PR_ATTEMPT_BUDGET/g) ?? [];
  assert.equal(
    budgetDefinitions.length,
    1,
    'the attempt budget must be one constant, not several knobs',
  );
  assert.match(workflow, /OPENCODE_PR_ATTEMPT_BUDGET:\s*["']\d+["']/);

  const budgetJob = workflowJob(workflow, 'budget');
  const opencodeJob = workflowJob(workflow, 'opencode');

  const gate = budgetJob.indexOf('- name: Check the attempt budget');
  const keyCheck = opencodeJob.indexOf('- name: Check the model key');
  const model = opencodeJob.indexOf('- name: Run OpenCode');
  assert.notEqual(gate, -1, 'opencode.yml must have a budget gate step');
  assert.notEqual(keyCheck, -1, 'opencode.yml must have a model-key check step');
  assert.notEqual(model, -1, 'opencode.yml must still run the model');
  assert.ok(keyCheck < model, 'the model-key check must run before the model');

  const gateStep = budgetJob.slice(gate);
  assert.match(gateStep, /id:\s*gate/);
  assert.match(gateStep, /run:\s*node scripts\/opencode-budget\.mjs check/);
  assert.match(gateStep, /GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/);
  assert.doesNotMatch(
    gateStep,
    /OPENCODE_API_KEY/,
    'the gate must not see the model key',
  );
  assert.doesNotMatch(
    gateStep,
    /continue-on-error/,
    'a failed gate must fail the job and block the model',
  );

  assert.match(
    budgetJob,
    /ref:\s*\$\{\{\s*github\.event\.repository\.default_branch\s*\}\}/,
    'the write-scoped gate must run the script from the default branch, not from the PR merge ref',
  );
  assert.doesNotMatch(
    budgetJob,
    /uses:\s*anomalyco\/opencode\/github@/,
    'the model must not share a job with the write-scoped workflow token',
  );
  assert.doesNotMatch(
    opencodeJob,
    /opencode-budget\.mjs/,
    'the gate script must not run in the job that checks out the pull request',
  );
  assert.match(budgetJob, /outputs:\n\s+allowed:/, 'the gate must publish its decision');

  assert.match(opencodeJob, /needs:\s*budget/, 'the model job waits for the gate job');
  assert.match(
    opencodeJob,
    /if:\s*needs\.budget\.outputs\.allowed == 'true'/,
    'the model job must only run when the gate allows it',
  );

  const modelStep = opencodeJob.slice(model);
  assert.doesNotMatch(
    modelStep,
    /(GH_TOKEN|GITHUB_TOKEN):|github\.token|secrets\.GITHUB_TOKEN/,
    'the model step must not receive the workflow token',
  );
  assert.match(modelStep, /OPENCODE_API_KEY/, 'the model step still needs its own key');

  assert.match(workflow, /actions: read/, 'the gate reads the Actions run history');
  assert.doesNotMatch(
    workflow,
    /workflow_dispatch/,
    'a manual trigger would bypass the budget',
  );
});

test('the budget script, its unit tests and the docs are wired into the repository', () => {
  const script = read('scripts/opencode-budget.mjs');
  assert.match(script, /actions\/workflows\/opencode\.yml\/runs/);
  assert.match(script, /display_title !== tag/);
  assert.match(script, /currentRunTagMatches/);
  assert.match(script, /run_attempt/);
  assert.match(script, /limit_exhausted/);
  assert.match(script, /budget_check_error/);
  assert.match(script, /needs human/);
  assert.match(script, /NOTICE_MARKER/);

  const tests = read('scripts/opencode-budget.test.mjs');
  assert.match(tests, /countAttempts/);
  assert.match(tests, /decide/);

  assert.match(
    miseTask('check:ci'),
    /opencode-budget\.test\.mjs/,
    'the attempt-counting unit tests must run in check:ci',
  );

  const docs = read('docs/ci.md');
  for (const term of [
    'OPENCODE_PR_ATTEMPT_BUDGET',
    'limit_exhausted',
    'budget_check_error',
    'needs human',
  ]) {
    assert.match(docs, new RegExp(term), `docs/ci.md must document ${term}`);
  }

  const budgetWorkflows = readdirSync(join(root, '.github/workflows')).filter((name) =>
    /budget/.test(name),
  );
  assert.deepEqual(
    budgetWorkflows,
    [],
    'the budget belongs in opencode.yml, not a separate workflow',
  );
});

test('the model key is checked before the agent', () => {
  const workflow = read('.github/workflows/opencode.yml');
  const opencodeJob = workflowJob(workflow, 'opencode');
  const keyCheck = opencodeJob.indexOf('- name: Check the model key');
  const model = opencodeJob.indexOf('- name: Run OpenCode');
  assert.ok(keyCheck !== -1 && keyCheck < model);
  assert.match(
    opencodeJob,
    /if:\s*needs\.budget\.outputs\.allowed == 'true'/,
    'the whole model job is gated on the budget job',
  );

  const keyStep = opencodeJob.slice(keyCheck, model);
  assert.match(
    keyStep,
    /OPENCODE_API_KEY:\s*\$\{\{\s*secrets\.OPENCODE_API_KEY\s*\}\}/,
    'the preflight must inspect the real secret',
  );
  assert.match(keyStep, /\[ -z "\$\{OPENCODE_API_KEY\}" \]/, 'an empty key must fail');
  assert.match(keyStep, /exit 1/);
  assert.doesNotMatch(
    keyStep,
    /GH_TOKEN|github\.token/,
    'the key check must not receive the workflow token',
  );
});

test('the agent cannot edit workflow files the App is not allowed to push', () => {
  const workflow = read('.github/workflows/opencode.yml');
  const opencodeJob = workflowJob(workflow, 'opencode');

  assert.match(
    opencodeJob,
    /OPENCODE_PERMISSION:/,
    'the model job must scope what the agent may do',
  );
  assert.match(
    opencodeJob,
    /"external_directory":\s*"deny"/,
    'a headless run cannot answer a prompt for a path outside the checkout',
  );
  // The App has no `workflows` permission and an installation cannot widen what the
  // App requests, so any push that touches `.github/workflows/**` is rejected by
  // GitHub after the work is done. Rules are evaluated last-match-wins, so the
  // broad allow has to come first.
  assert.match(
    opencodeJob,
    /"edit":\s*\{[^}]*"\*":\s*"allow"[^}]*"\.github\/workflows\/\*\*":\s*"deny"[^}]*\}/s,
    'the agent must not edit a workflow file: the App push would be rejected',
  );
  assert.doesNotMatch(
    opencodeJob,
    /"\.github\/workflows\/\*\*":\s*"allow"/,
    'a later allow rule would re-enable workflow edits',
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
    /Reviewed commit \\?`%s\\?`\. \[Workflow run\]\(%s\)/,
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
    /Reviewed commit \\?`%s\\?`/,
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
