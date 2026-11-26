import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSandbox } from './sandbox.mjs';
import { createFakeGitHub } from './fake-github.mjs';
import { onReleaseMerge, syncAllReleases, summarizeSync, summarizeReleaseMerge } from '../src/sync.mjs';
import { CONFLICT_LABEL } from '../src/release-pr.mjs';

const identity = { name: 'release-bot[bot]', email: 'bot@example.com' };
const repository = 'HeyReach/demo';
let sb;
afterEach(() => sb?.cleanup());

/** release/v2.16.0 cut from master, an rc merged into it, then master moved on. */
function setup({ conflicting = false } = {}) {
  sb = createSandbox();
  sb.edit('shared.txt', 'base\n').push('master');
  sb.checkout('release/v2.16.0', { create: true }).push('release/v2.16.0');
  sb.checkout('rc/inbox', { create: true }).edit(conflicting ? 'shared.txt' : 'rc.txt', 'from rc\n', 'rc work').commit('rc feature');
  sb.checkout('release/v2.16.0').merge('rc/inbox').push('release/v2.16.0');
  sb.checkout('master').edit(conflicting ? 'shared.txt' : 'other.txt', 'from master\n', 'released elsewhere').push('master');
  return sb;
}

const merged = (git, github, extra = {}) => onReleaseMerge({
  git, github, repository, base: 'release/v2.16.0', head: 'rc/inbox', merged: true, mainBranch: 'master', identity, ...extra,
});

test('RC merged: deletes the RC, pulls master in, opens the release PR with auto-merge', async () => {
  setup();
  const github = createFakeGitHub();
  const r = await merged(sb.runner(), github);

  assert.deepEqual(github.state.deletedRefs, ['rc/inbox']);
  assert.equal(r.sync.status, 'merged');
  sb.pull();
  const git = sb.runner();
  assert.ok(git.isAncestor('origin/master', 'origin/release/v2.16.0'), 'master is now inside the release');

  assert.equal(github.state.pulls.length, 1);
  const pr = github.state.pulls[0];
  assert.deepEqual([pr.head, pr.base, pr.title], ['release/v2.16.0', 'master', 'Release v2.16.0']);
  assert.deepEqual(github.state.autoMerge, [`PR_${pr.number}`]);
  assert.match(summarizeReleaseMerge(r), /Deleted `rc\/inbox`[\s\S]*Opened release PR #100[\s\S]*merged in[\s\S]*Auto-merge enabled/);
});

test('a second RC reuses the same release PR', async () => {
  setup();
  const github = createFakeGitHub();
  await merged(sb.runner(), github);
  const r = await merged(sb.runner(), github, { head: 'rc/second' });
  assert.equal(github.state.pulls.length, 1);
  assert.equal(r.prCreated, false);
  assert.equal(r.sync.status, 'up-to-date');
});

test('conflict: nothing pushed, PR labelled once with the files, label cleared when fixed', async () => {
  setup({ conflicting: true });
  const github = createFakeGitHub();
  const before = sb.originSha('release/v2.16.0');
  const r = await merged(sb.runner(), github);

  assert.equal(r.sync.status, 'conflict');
  assert.deepEqual(r.sync.files, ['shared.txt']);
  assert.equal(sb.originSha('release/v2.16.0'), before, 'release branch untouched');
  const n = r.pr;
  assert.deepEqual(github.state.labels[n], [CONFLICT_LABEL]);
  assert.equal(github.state.comments[n].length, 1);
  assert.match(github.state.comments[n][0], /`shared\.txt`/);

  // The next master push conflicts again: no duplicate label or comment.
  await syncAllReleases({ git: sb.runner(), github, repository, mainBranch: 'master', identity });
  assert.deepEqual(github.state.labels[n], [CONFLICT_LABEL]);
  assert.equal(github.state.comments[n].length, 1);

  // Someone resolves it by hand; the next sync clears the label.
  sb.checkout('release/v2.16.0').pull();
  try { sb.merge('master'); } catch { sb.edit('shared.txt', 'resolved\n', 'resolve'); }
  sb.push('release/v2.16.0');
  const results = await syncAllReleases({ git: sb.runner(), github, repository, mainBranch: 'master', identity });
  assert.equal(results[0].status, 'up-to-date');
  assert.deepEqual(github.state.labels[n], []);
});

test('master push syncs every open release, oldest first, and reports each', async () => {
  setup();
  sb.checkout('release/v2.17.0', { create: true, from: 'master~1' }).commit('2.17 work').push('release/v2.17.0');
  sb.checkout('master').commit('more released work').push('master');
  const github = createFakeGitHub();
  const results = await syncAllReleases({ git: sb.runner(), github, repository, mainBranch: 'master', identity });
  assert.deepEqual(results.map((r) => [r.branch, r.status]), [['release/v2.16.0', 'merged'], ['release/v2.17.0', 'merged']]);
  assert.match(summarizeSync(results), /`release\/v2\.16\.0` \| 🔀 master merged in/);
});

test('never overwrites a push someone made to the release meanwhile', async () => {
  setup();
  const github = createFakeGitHub();
  const runner = sb.runner(); // fetched before the human push below
  sb.checkout('release/v2.16.0').commit('human pushed a fix').push('release/v2.16.0');
  const humanSha = sb.originSha('release/v2.16.0');
  const results = await syncAllReleases({ git: runner, github, repository, mainBranch: 'master', identity });
  assert.equal(results[0].status, 'error');
  assert.equal(sb.originSha('release/v2.16.0'), humanSha);
});

test('auto-merge not available is reported, not fatal', async () => {
  setup();
  const github = createFakeGitHub();
  github.state.autoMergeError = 'Auto merge is not allowed for this repository';
  const r = await merged(sb.runner(), github);
  assert.equal(r.autoMergeError, 'Auto merge is not allowed for this repository');
  assert.match(summarizeReleaseMerge(r), /Auto-merge not enabled/);
});

test('closed without merging, or not into a release: nothing happens', async () => {
  setup();
  const github = createFakeGitHub();
  assert.ok((await merged(sb.runner(), github, { merged: false })).skipped);
  assert.ok((await merged(sb.runner(), github, { base: 'master' })).skipped);
  assert.equal(github.state.pulls.length, 0);
});

test('a feature branch merged into a release is not deleted by the bot', async () => {
  setup();
  const github = createFakeGitHub();
  const r = await merged(sb.runner(), github, { head: 'feature/HR-1' });
  assert.equal(r.deleted, false);
  assert.deepEqual(github.state.deletedRefs, []);
});

test('releases already merged into master are not synced again', async () => {
  setup();
  sb.checkout('master').merge('release/v2.16.0').push('master');
  const before = sb.originSha('release/v2.16.0');
  const results = await syncAllReleases({ git: sb.runner(), github: createFakeGitHub(), repository, mainBranch: 'master', identity });
  assert.deepEqual(results, []);
  assert.equal(sb.originSha('release/v2.16.0'), before);
});
