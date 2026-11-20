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
  assert.match(workflow, /permissions:\n\s+contents: read\n\s+id-token: write\n\s+issues: write/);
  assert.doesNotMatch(
    workflow,
    /(contents|pull-requests):\s*write/,
    'git writes must come from the OpenCode App token, not the workflow',
  );
  assert.match(
    workflow,
    /GH_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/,
    'the agent needs an issues-scoped token to publish tickets with gh',
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

test('release-please prefers a PAT and falls back to GITHUB_TOKEN', () => {
  const workflow = read('.github/workflows/release-please.yml');

  assert.match(
    workflow,
    /token:\s*\$\{\{\s*secrets\.RELEASE_PLEASE_TOKEN\s*\|\|\s*secrets\.GITHUB_TOKEN\s*\}\}/,
  );
});
