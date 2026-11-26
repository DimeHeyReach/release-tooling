import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSandbox } from './sandbox.mjs';
import { createFakeGitHub } from './fake-github.mjs';
import { scrapRelease, summarizeScrap } from '../src/scrap.mjs';
import { runCleanup, planCleanup, summarizeCleanup } from '../src/cleanup.mjs';
import { planMigration, applyMigration, summarizeMigration } from '../src/migrate.mjs';
import { createRelease } from '../src/create-release.mjs';
import { DEPLOYED_LABEL } from '../src/deployed.mjs';

const repository = 'HeyReach/demo';
let sb;
afterEach(() => sb?.cleanup());

// ---------- scrap ----------

function releaseWithPr({ live = false } = {}) {
  sb = createSandbox();
  sb.checkout('release/v2.16.0', { create: true }).commit('2.16').push('release/v2.16.0').checkout('master');
  const github = createFakeGitHub();
  github.state.pulls.push({ number: 5, state: 'open', head: 'release/v2.16.0', base: 'master' });
  github.state.pulls.push({ number: 6, state: 'open', head: 'rc/late', base: 'release/v2.16.0' });
  if (live) github.state.labels[5] = [DEPLOYED_LABEL];
  return github;
}

test('scrap: marker created, PR commented and closed, branch deleted, number burned', async () => {
  const github = releaseWithPr();
  const sha = sb.originSha('release/v2.16.0');
  const r = await scrapRelease({ git: sb.runner(), github, repository, version: 'v2.16.0', actor: 'dimitar' });

  assert.ok(!sb.originBranches().includes('release/v2.16.0'));
  assert.equal(sb.originSha('scrapped/v2.16.0'), sha);
  assert.equal(github.state.pulls.find((p) => p.number === 5).state, 'closed');
  assert.match(github.state.comments[5][0], /scrapped by @dimitar/);
  assert.deepEqual(r.incoming, [{ number: 6, head: 'rc/late' }]);
  assert.match(summarizeScrap(r), /#6 `rc\/late`/);

  const next = createRelease(sb.runner(), { bump: 'minor' });
  assert.equal(next.plan.branch, 'release/v2.17.0', 'the scrapped number is never reused');
});

test('scrap a live release: allowed, with a rollback reminder', async () => {
  const github = releaseWithPr({ live: true });
  const r = await scrapRelease({ git: sb.runner(), github, repository, version: '2.16.0' });
  assert.equal(r.wasLive, true);
  assert.match(github.state.comments[5][0], /still live in production: roll back in Microtica/);
  assert.match(summarizeScrap(r), /still live in production/);
});

test('scrap refuses a release already merged into master', async () => {
  const github = releaseWithPr();
  sb.merge('release/v2.16.0').push('master');
  await assert.rejects(scrapRelease({ git: sb.runner(), github, repository, version: 'v2.16.0' }), /already merged into master/);
  assert.ok(sb.originBranches().includes('release/v2.16.0'));
});

test('scrap refuses unknown or malformed versions', async () => {
  const github = releaseWithPr();
  await assert.rejects(scrapRelease({ git: sb.runner(), github, repository, version: 'v2.99.0' }), /does not exist/);
  await assert.rejects(scrapRelease({ git: sb.runner(), github, repository, version: 'latest' }), /not a version/);
});

test('scrap does not delete a branch someone pushed to meanwhile', async () => {
  const github = releaseWithPr();
  const runner = sb.runner();
  sb.checkout('release/v2.16.0').commit('late push').push('release/v2.16.0').checkout('master');
  await assert.rejects(scrapRelease({ git: runner, github, repository, version: 'v2.16.0' }));
  assert.ok(sb.originBranches().includes('release/v2.16.0'));
});

// ---------- cleanup ----------

const DAY = 24 * 60 * 60 * 1000;

function mergedTaggedRelease(version) {
  sb.checkout(`release/${version}`, { create: true }).commit(version).tag(version).push(`release/${version}`, version);
  sb.checkout('master').merge(`release/${version}`).push('master');
}

test('cleanup deletes merged+tagged branches older than 90 days, keeps the rest', () => {
  sb = createSandbox();
  mergedTaggedRelease('v2.14.0');
  sb.checkout('release/v2.15.0', { create: true }).commit('untagged').push('release/v2.15.0');
  sb.checkout('master').merge('release/v2.15.0').push('master');
  sb.checkout('release/v2.16.0', { create: true }).commit('open').push('release/v2.16.0').checkout('master');

  const fresh = planCleanup({ git: sb.runner() });
  assert.deepEqual(fresh.map((p) => p.action), ['keep', 'keep', 'keep'], 'merged today: too recent');

  const later = new Date(Date.now() + 91 * DAY);
  const dry = runCleanup({ git: sb.runner(), dryRun: true, now: later });
  assert.deepEqual(dry.map((p) => [p.branch, p.action]), [
    ['release/v2.14.0', 'delete'], ['release/v2.15.0', 'keep'], ['release/v2.16.0', 'keep'],
  ]);
  assert.match(dry[1].reason, /no v2\.15\.0 tag/);
  assert.equal(dry[2].reason, 'not merged');
  assert.ok(sb.originBranches().includes('release/v2.14.0'), 'dry run changes nothing');
  assert.match(summarizeCleanup(dry, { dryRun: true, days: 90 }), /`release\/v2\.14\.0` \| would delete/);

  runCleanup({ git: sb.runner(), now: later });
  assert.ok(!sb.originBranches().includes('release/v2.14.0'));
  assert.equal(sb.originSha('v2.14.0').length, 40, 'tag kept');
});

// ---------- migration ----------

function legacyRepo() {
  sb = createSandbox();
  // v2.13.0: merged long ago, branch deleted, never tagged.
  sb.checkout('release/v2.13.0', { create: true }).commit('2.13').push('release/v2.13.0');
  sb.checkout('master').merge('release/v2.13.0').push('master').deleteRemote('release/v2.13.0');
  // v2.14.0: master was merged INTO it before it shipped, then merged into master; branch kept.
  sb.checkout('release/v2.14.0', { create: true }).commit('2.14');
  sb.checkout('master').commit('hotfix on master');
  sb.checkout('release/v2.14.0').merge('master', 'Merge master into release/v2.14.0').push('release/v2.14.0');
  sb.checkout('master').merge('release/v2.14.0', 'Merge pull request #12 from HeyReach/release/v2.14.0').push('master');
  // v2.15.0 and v2.16.0: open, not merged.
  sb.checkout('release/v2.15.0', { create: true }).commit('2.15').push('release/v2.15.0');
  sb.checkout('master').checkout('release/v2.16.0', { create: true }).commit('2.16').push('release/v2.16.0');
  sb.checkout('master');
}

test('migration dry run: recovers lost history, lists unmerged branches, changes nothing', () => {
  legacyRepo();
  const plan = planMigration({ git: sb.runner() });
  assert.deepEqual(plan.tags.map((t) => t.tag), ['v2.13.0', 'v2.14.0']);
  assert.equal(plan.tags[1].sha, sb.originSha('release/v2.14.0'), 'tagged at what was merged, not at the master-into-release merge');
  assert.deepEqual(plan.unmerged.map((u) => [u.branch, u.decision]), [['release/v2.15.0', 'keep open'], ['release/v2.16.0', 'keep open']]);
  assert.match(summarizeMigration(plan, { dryRun: true }), /dry run[\s\S]*`v2\.13\.0`[\s\S]*Scrap/);
});

test('migration apply: tags created, chosen branches scrapped, numbers then come out right', () => {
  legacyRepo();
  const plan = planMigration({ git: sb.runner(), scrap: ['v2.15.0'] });
  applyMigration({ git: sb.runner(), plan });

  assert.ok(sb.originSha('v2.13.0'));
  assert.ok(sb.originSha('scrapped/v2.15.0'));
  assert.ok(!sb.originBranches().includes('release/v2.15.0'));
  assert.deepEqual(planMigration({ git: sb.runner() }).tags, [], 'running it again finds nothing to do');

  const next = createRelease(sb.runner(), { bump: 'minor', proceedWithUnmerged: true });
  assert.equal(next.plan.branch, 'release/v2.17.0');
  assert.deepEqual(next.plan.unmerged, ['release/v2.16.0']);
});

test('migration refuses to scrap something that is not an open unmerged release', () => {
  legacyRepo();
  assert.throws(() => planMigration({ git: sb.runner(), scrap: ['v2.14.0'] }), /not open, unmerged/);
});

test('migration ignores merges that only reached master indirectly', () => {
  sb = createSandbox();
  // v2.14.0 never shipped, but someone merged it into an RC that went out in v2.15.0.
  sb.checkout('release/v2.14.0', { create: true }).commit('2.14, never shipped').push('release/v2.14.0');
  sb.deleteRemote('release/v2.14.0');
  sb.checkout('master').checkout('release/v2.15.0', { create: true }).push('release/v2.15.0');
  sb.checkout('rc/x', { create: true }).commit('rc').merge('release/v2.14.0', 'Merge release/v2.14.0 into rc/x');
  sb.checkout('release/v2.15.0').merge('rc/x').push('release/v2.15.0');
  sb.checkout('master').merge('release/v2.15.0', 'Merge pull request #20 from HeyReach/release/v2.15.0').push('master');
  assert.deepEqual(planMigration({ git: sb.runner() }).tags.map((t) => t.tag), ['v2.15.0']);
});
