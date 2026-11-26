import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSandbox } from './sandbox.mjs';
import { createRelease, planCreateRelease, summarize } from '../src/create-release.mjs';

let sb;
afterEach(() => sb?.cleanup());

/** master has v2.15.0 released and merged; v2.16.0 is cut but not merged. */
function historyWithOneUnmerged() {
  sb = createSandbox();
  sb.checkout('release/v2.15.0', { create: true }).commit('2.15 work').tag('v2.15.0').push('release/v2.15.0', 'v2.15.0');
  sb.checkout('master').merge('release/v2.15.0').push('master');
  sb.checkout('release/v2.16.0', { create: true }).commit('2.16 work').push('release/v2.16.0');
  sb.checkout('master');
  return sb;
}

test('stops when a release is not merged, and names it', () => {
  historyWithOneUnmerged();
  const result = createRelease(sb.runner(), { bump: 'minor' });
  assert.equal(result.created, false);
  assert.equal(result.plan.branch, 'release/v2.17.0');
  assert.deepEqual(result.plan.unmerged, ['release/v2.16.0']);
  assert.ok(!sb.originBranches().includes('release/v2.17.0'));
  assert.match(summarize(result), /Not created.*\n[\s\S]*release\/v2\.16\.0[\s\S]*Proceed with unmerged releases/);
});

test('creates it from master when told to proceed anyway', () => {
  historyWithOneUnmerged();
  const result = createRelease(sb.runner(), { bump: 'minor', proceedWithUnmerged: true });
  assert.equal(result.created, true);
  assert.equal(sb.originSha('release/v2.17.0'), sb.originSha('master'));
  assert.match(summarize(result), /Created `release\/v2\.17\.0`[\s\S]*Created anyway/);
});

test('creates without asking when everything is merged', () => {
  sb = createSandbox();
  sb.checkout('release/v2.15.0', { create: true }).commit().tag('v2.15.0').push('release/v2.15.0', 'v2.15.0');
  sb.checkout('master').merge('release/v2.15.0').push('master');
  const result = createRelease(sb.runner(), { bump: 'major' });
  assert.equal(result.created, true);
  assert.equal(result.plan.branch, 'release/v3.0.0');
  assert.deepEqual(result.plan.unmerged, []);
});

test('a scrapped number is skipped', () => {
  historyWithOneUnmerged();
  sb.deleteRemote('release/v2.16.0').tag('scrapped/v2.16.0').push('scrapped/v2.16.0');
  const result = createRelease(sb.runner(), { bump: 'minor' });
  assert.equal(result.created, true);
  assert.equal(result.plan.branch, 'release/v2.17.0');
});

test('a patch is cut from the release it patches, not from master', () => {
  historyWithOneUnmerged();
  const result = createRelease(sb.runner(), { bump: 'patch', patchOf: 'v2.16.0', proceedWithUnmerged: true });
  assert.equal(result.plan.branch, 'release/v2.16.1');
  assert.equal(result.plan.baseRef, 'origin/release/v2.16.0');
  assert.equal(sb.originSha('release/v2.16.1'), sb.originSha('release/v2.16.0'));
});

test('a patch falls back to the tag when the branch was cleaned up', () => {
  sb = createSandbox();
  sb.checkout('release/v2.15.0', { create: true }).commit().tag('v2.15.0').push('release/v2.15.0', 'v2.15.0');
  sb.checkout('master').merge('release/v2.15.0').push('master').deleteRemote('release/v2.15.0');
  const plan = planCreateRelease(sb.runner(), { bump: 'patch', patchOf: '2.15.0' });
  assert.equal(plan.branch, 'release/v2.15.1');
  assert.equal(plan.baseRef, 'v2.15.0');
});

test('a patch never starts from a scrapped patch', () => {
  sb = createSandbox();
  sb.checkout('release/v2.15.0', { create: true }).commit().tag('v2.15.0').push('release/v2.15.0', 'v2.15.0');
  sb.checkout('release/v2.15.1', { create: true }).commit('bad fix').push('release/v2.15.1');
  sb.deleteRemote('release/v2.15.1').tag('scrapped/v2.15.1').push('scrapped/v2.15.1');
  const plan = planCreateRelease(sb.runner(), { bump: 'patch', patchOf: 'v2.15.0' });
  assert.equal(plan.branch, 'release/v2.15.2');
  assert.equal(plan.baseRef, 'origin/release/v2.15.0');
});

test('never overwrites a branch someone created a moment earlier', () => {
  historyWithOneUnmerged();
  const runner = sb.runner(); // fetched before the other run created v2.17.0
  sb.checkout('release/v2.17.0', { create: true, from: 'release/v2.16.0' }).push('release/v2.17.0').checkout('master');
  const before = sb.originSha('release/v2.17.0');
  assert.throws(() => runner.pushNewBranch(sb.originSha('master'), 'release/v2.17.0'));
  assert.equal(sb.originSha('release/v2.17.0'), before);
});

test('a bad patch version is refused with a clear message', () => {
  historyWithOneUnmerged();
  assert.throws(() => planCreateRelease(sb.runner(), { bump: 'patch', patchOf: 'latest' }), /not a version/);
  assert.throws(() => planCreateRelease(sb.runner(), { bump: 'patch', patchOf: 'v9.9.9' }), /does not exist/);
});
