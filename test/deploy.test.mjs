import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSandbox } from './sandbox.mjs';
import { createFakeGitHub } from './fake-github.mjs';
import { evaluateReadiness, updateAllReadiness, statusDescription, summarizeReadiness } from '../src/readiness.mjs';
import { handleDeployed, summarizeDeployed, DEPLOYED_LABEL } from '../src/deployed.mjs';
import { evaluateMergeGate } from '../src/merge-gate.mjs';
import { BEHIND_LABEL, readDeployedSha, writeDeployedSha, syncAllBehindFlags } from '../src/behind.mjs';

const repository = 'HeyReach/demo';
let sb;
afterEach(() => sb?.cleanup());

// ---------- release-ready ----------

/** v2.16.0 and v2.17.0 both cut from master; nothing merged yet. */
function twoReleases() {
  sb = createSandbox();
  sb.checkout('release/v2.16.0', { create: true }).commit('2.16').push('release/v2.16.0');
  sb.checkout('master').checkout('release/v2.17.0', { create: true }).commit('2.17').push('release/v2.17.0');
  sb.checkout('master');
  return sb;
}

test('the lowest release is ready; a higher one waits for it', () => {
  twoReleases();
  const git = sb.runner();
  assert.deepEqual(evaluateReadiness(git, 'release/v2.16.0'), { branch: 'release/v2.16.0', ok: true, problems: [] });
  const r = evaluateReadiness(git, 'release/v2.17.0');
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems, ['not merged or scrapped yet: v2.16.0']);
});

test('once the lower release is merged, the higher one needs master pulled in first', () => {
  twoReleases();
  sb.merge('release/v2.16.0').push('master');
  const r = evaluateReadiness(sb.runner(), 'release/v2.17.0');
  assert.deepEqual(r.problems, ['master has changes that are not in this release yet']);
  sb.checkout('release/v2.17.0').merge('master').push('release/v2.17.0').checkout('master');
  assert.ok(evaluateReadiness(sb.runner(), 'release/v2.17.0').ok);
});

test('a scrapped lower release no longer blocks', () => {
  twoReleases();
  sb.deleteRemote('release/v2.16.0').tag('scrapped/v2.16.0').push('scrapped/v2.16.0');
  assert.ok(evaluateReadiness(sb.runner(), 'release/v2.17.0').ok);
});

test('a lower release already contained in this one does not block (hotfix case)', () => {
  sb = createSandbox();
  sb.checkout('release/v2.16.0', { create: true }).commit('2.16').push('release/v2.16.0');
  sb.checkout('release/v2.16.1', { create: true }).commit('fix').push('release/v2.16.1').checkout('master');
  assert.ok(evaluateReadiness(sb.runner(), 'release/v2.16.1').ok);
});

test('publishes a release-ready status on every open release', async () => {
  twoReleases();
  const github = createFakeGitHub();
  const git = sb.runner();
  const results = await updateAllReadiness({ git, github, repository });
  assert.deepEqual(results.map((r) => r.ok), [true, false]);
  const byShas = Object.fromEntries(github.state.statuses.map((s) => [s.sha, s]));
  const s17 = byShas[git.sha('origin/release/v2.17.0')];
  assert.deepEqual([s17.context, s17.state], ['release-ready', 'failure']);
  assert.equal(s17.description, 'Not ready: not merged or scrapped yet: v2.16.0');
  assert.equal(byShas[git.sha('origin/release/v2.16.0')].state, 'success');
  assert.match(summarizeReadiness(results), /`release\/v2\.17\.0` \| ⛔ no \| not merged/);
});

test('status descriptions fit GitHub’s 140-character limit', () => {
  const long = { ok: false, problems: [`not merged or scrapped yet: ${Array.from({ length: 30 }, (_, i) => `v2.${i}.0`).join(', ')}`] };
  assert.equal(statusDescription(long).length, 140);
});

// ---------- deployed handler ----------

const SHA = 'a'.repeat(40);
function deployFixture({ branch = true, tag = false, compare = 'ahead', prs = [] } = {}) {
  const github = createFakeGitHub();
  if (branch) github.state.refs.add('heads/release/v2.16.0');
  if (tag) github.state.refs.add('tags/v2.16.0');
  github.state.compare[`${SHA}...${branch ? 'release/v2.16.0' : 'v2.16.0'}`] = compare;
  for (const p of prs) {
    github.state.pulls.push({ state: 'open', base: 'master', headSha: SHA, ...p });
    if (p.labels) github.state.labels[p.number] = [...p.labels];
  }
  return github;
}
const deploy = (github, payload = {}) =>
  handleDeployed({ github, repository, payload: { version: '2.16.0', sha: SHA, environment: 'production', ...payload } });

test('first production deploy: tag created, label added', async () => {
  const github = deployFixture({ prs: [{ number: 5, head: 'release/v2.16.0' }] });
  const r = await deploy(github);
  assert.equal(r.tagCreated, true);
  assert.deepEqual(github.state.createdRefs, [{ ref: 'refs/tags/v2.16.0', sha: SHA }]);
  assert.deepEqual(github.state.labels[5], [DEPLOYED_LABEL]);
  assert.match(summarizeDeployed(r), /v2\.16\.0 is live[\s\S]*Tag `v2\.16\.0` created[\s\S]*label is now on PR #5/);
});

test('the label moves: only the release live now has it', async () => {
  const github = deployFixture({ prs: [
    { number: 4, head: 'release/v2.15.0', labels: [DEPLOYED_LABEL] },
    { number: 5, head: 'release/v2.16.0' },
  ] });
  const r = await deploy(github);
  assert.deepEqual(github.state.labels[4], []);
  assert.deepEqual(github.state.labels[5], [DEPLOYED_LABEL]);
  assert.deepEqual(r.removedFrom, [4]);
});

test('redeploy or rollback: existing tag is kept, not moved', async () => {
  const github = deployFixture({ tag: true, prs: [{ number: 5, head: 'release/v2.16.0' }] });
  const r = await deploy(github);
  assert.equal(r.tagCreated, false);
  assert.deepEqual(github.state.createdRefs, []);
  assert.match(summarizeDeployed(r), /already existed/);
});

test('rollback to a release whose branch was cleaned up: checked against its tag', async () => {
  const github = deployFixture({ branch: false, tag: true, prs: [{ number: 9, head: 'release/v2.17.0', labels: [DEPLOYED_LABEL] }] });
  const r = await deploy(github);
  assert.deepEqual(github.state.labels[9], [], 'label removed from the release that is no longer live');
  assert.equal(r.pr, null);
  assert.match(r.warnings[0], /No open release PR/);
});

test('non-production deploys change nothing', async () => {
  const github = deployFixture({ prs: [{ number: 5, head: 'release/v2.16.0' }] });
  for (const environment of ['staging', 'dev', '', undefined]) {
    const r = await deploy(github, { environment });
    assert.ok(r.ignored);
  }
  assert.deepEqual(github.state.createdRefs, []);
  assert.equal(github.state.labels[5], undefined);
});

test('a commit that is not part of the release is refused, nothing changes', async () => {
  const github = deployFixture({ compare: 'diverged', prs: [{ number: 5, head: 'release/v2.16.0' }] });
  await assert.rejects(deploy(github), /not part of release\/v2\.16\.0\. Nothing was changed/);
  assert.deepEqual(github.state.createdRefs, []);
  assert.equal(github.state.labels[5], undefined);
});

test('unknown version or bad input is refused', async () => {
  await assert.rejects(deploy(deployFixture({ branch: false })), /no release branch and no tag/);
  await assert.rejects(deploy(deployFixture(), { version: 'latest' }), /not a version/);
  await assert.rejects(deploy(deployFixture(), { sha: 'abc' }), /not a full commit SHA/);
});

// ---------- merge gate ----------

test('merge gate: only the release live in production may merge', () => {
  assert.ok(evaluateMergeGate({ base: 'master', head: 'release/v2.16.0', labels: [DEPLOYED_LABEL] }).ok);
  const no = evaluateMergeGate({ base: 'master', head: 'release/v2.16.0', labels: ['release:conflict'] });
  assert.equal(no.ok, false);
  assert.match(no.message, /not live in production/);
  assert.ok(!evaluateMergeGate({ base: 'master', head: 'rc/x', labels: [DEPLOYED_LABEL] }).ok);
  assert.ok(evaluateMergeGate({ base: 'release/v2.16.0', head: 'rc/x', labels: [] }).ok, 'PRs into releases are not gated');
});

// ---------- behind production ----------

const NEWER = 'b'.repeat(40);

test('deploy records the exact commit in the PR description', async () => {
  const github = deployFixture({ prs: [{ number: 5, head: 'release/v2.16.0', body: 'Release v2.16.0.' }] });
  await deploy(github);
  const pr = github.state.pulls.find((p) => p.number === 5);
  assert.equal(readDeployedSha(pr.body), SHA);
  assert.match(pr.body, /^Release v2\.16\.0\./, 'existing description kept');
});

test('deploying an older commit than the branch head flags the PR once', async () => {
  const github = deployFixture({ prs: [{ number: 5, head: 'release/v2.16.0', headSha: NEWER }] });
  const r = await deploy(github);
  assert.equal(r.behind, true);
  assert.deepEqual(github.state.labels[5], [DEPLOYED_LABEL, BEHIND_LABEL]);
  assert.equal(github.state.comments[5].length, 1);
  assert.match(github.state.comments[5][0], /Production is behind `release\/v2\.16\.0`[\s\S]*Deployed: `aaaaaaa`[\s\S]*Branch now: `bbbbbbb`[\s\S]*compare\/a{40}\.\.\.b{40}/);
  assert.match(summarizeDeployed(r), /newer commits than what was deployed/);
});

test('new commits on the live release raise the flag; redeploying clears it', async () => {
  const github = deployFixture({ prs: [{ number: 5, head: 'release/v2.16.0' }] });
  await deploy(github);
  assert.deepEqual(github.state.labels[5], [DEPLOYED_LABEL]);

  // master is pulled into the release after the deploy: branch moves on.
  github.state.pulls.find((p) => p.number === 5).headSha = NEWER;
  let results = await syncAllBehindFlags(github, { repository });
  assert.deepEqual(results.map((r) => [r.number, r.behind]), [[5, true]]);
  assert.ok(github.state.labels[5].includes(BEHIND_LABEL));
  await syncAllBehindFlags(github, { repository });
  assert.equal(github.state.comments[5].length, 1, 'no duplicate comment');

  // The newer commit is deployed.
  github.state.compare[`${NEWER}...release/v2.16.0`] = 'identical';
  github.state.refs.add('tags/v2.16.0');
  await deploy(github, { sha: NEWER });
  assert.deepEqual(github.state.labels[5], [DEPLOYED_LABEL]);
});

test('when another release goes live, the old PR loses the behind flag too', async () => {
  const github = deployFixture({ prs: [{ number: 4, head: 'release/v2.15.0', headSha: NEWER, labels: [DEPLOYED_LABEL, BEHIND_LABEL] },
    { number: 5, head: 'release/v2.16.0' }] });
  await deploy(github);
  assert.deepEqual(github.state.labels[4], []);
});

test('deployed-sha marker is replaced, not duplicated', () => {
  const once = writeDeployedSha('text', SHA);
  const twice = writeDeployedSha(once, NEWER);
  assert.equal(readDeployedSha(twice), NEWER);
  assert.equal(twice.match(/deployed-sha=/g).length, 1);
  assert.equal(readDeployedSha('no marker'), null);
});

test('merge gate lets the bot\'s workflow-update PR through, nothing else', () => {
  const bot = 'dime-release-bot[bot]';
  assert.ok(evaluateMergeGate({ base: 'master', head: 'release-tooling/install', labels: [], author: bot, botLogin: bot }).ok);
  assert.ok(!evaluateMergeGate({ base: 'master', head: 'release-tooling/install', labels: [], author: 'mallory', botLogin: bot }).ok);
});

test('a shipped release that got master synced back into it still counts as merged', () => {
  twoReleases();
  sb.merge('release/v2.16.0').push('master');                                   // 2.16 ships
  sb.checkout('release/v2.16.0').merge('master', 'Merge master into release/v2.16.0').push('release/v2.16.0'); // old sync behaviour
  sb.checkout('release/v2.17.0').merge('master').push('release/v2.17.0').checkout('master');
  assert.ok(evaluateReadiness(sb.runner(), 'release/v2.17.0').ok);
});

test('a shipped release shows as shipped, not "not ready", even after master moves on', () => {
  twoReleases();
  sb.merge('release/v2.16.0').push('master').commit('later work on master').push('master');
  const r = evaluateReadiness(sb.runner(), 'release/v2.16.0');
  assert.deepEqual([r.ok, r.shipped], [true, true]);
  assert.match(statusDescription(r), /^Shipped: already merged/);
});
