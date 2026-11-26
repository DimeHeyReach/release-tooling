import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVersion, formatVersion, parseReleaseBranch, usedVersions, nextVersion,
  isRcBranch, isHotfixBranch, checkReleaseSource,
} from '../src/versions.mjs';

const v = (s) => parseVersion(s);
const next = (bump, refs, patchOf) => formatVersion(nextVersion(bump, usedVersions(refs), patchOf && v(patchOf)));

test('parses only strict vMAJOR.MINOR.PATCH', () => {
  assert.deepEqual(v('v2.15.1'), { major: 2, minor: 15, patch: 1 });
  for (const bad of ['2.15.1', 'v2.15', 'v2.15.1.0', 'v02.1.0', 'v2.15.1-rc', 'relase/v2.15.1']) {
    assert.equal(v(bad), null, bad);
  }
});

test('release branch names', () => {
  assert.deepEqual(parseReleaseBranch('release/v2.15.1'), { major: 2, minor: 15, patch: 1 });
  assert.equal(parseReleaseBranch('relase/v2.15.1'), null);
  assert.equal(parseReleaseBranch('release/2.15.1'), null);
});

test('minor and major bump from the highest version ever used', () => {
  const refs = { branches: ['release/v2.15.1', 'release/v2.16.0', 'main'], tags: ['v2.15.0', 'v2.15.1'] };
  assert.equal(next('minor', refs), 'v2.17.0');
  assert.equal(next('major', refs), 'v3.0.0');
});

test('scrapped numbers are burned and never reused', () => {
  const refs = { branches: ['release/v2.15.0'], tags: ['v2.15.0', 'scrapped/v2.16.0'] };
  assert.equal(next('minor', refs), 'v2.17.0');
});

test('deleted branches still count through their tag', () => {
  assert.equal(next('minor', { branches: [], tags: ['v2.20.3'] }), 'v2.21.0');
});

test('patch bumps the line it patches, even when a newer minor exists', () => {
  const refs = { branches: ['release/v2.16.0', 'release/v2.17.0'], tags: ['v2.16.0'] };
  assert.equal(next('patch', refs, 'v2.16.0'), 'v2.16.1');
});

test('patch takes the highest patch in that line', () => {
  const refs = { branches: ['release/v2.16.1'], tags: ['v2.16.0', 'scrapped/v2.16.2'] };
  assert.equal(next('patch', refs, 'v2.16.1'), 'v2.16.3');
});

test('patch of a version that never existed is refused', () => {
  assert.throws(() => next('patch', { tags: ['v2.16.0'] }, 'v2.18.0'), /does not exist/);
  assert.throws(() => next('patch', { tags: ['v2.16.0'] }), /needs the release it patches/);
});

test('first release in a repo with no history', () => {
  assert.equal(next('minor', {}), 'v0.1.0');
  assert.equal(next('major', {}), 'v1.0.0');
});

test('rc and hotfix naming', () => {
  assert.ok(isRcBranch('rc/linkedin-inbox'));
  assert.ok(!isRcBranch('rc/'));
  assert.ok(!isRcBranch('feature/x'));
  assert.ok(isHotfixBranch('hotfix/HR-7488'));
  assert.ok(isHotfixBranch('hotfix/HR-7488_fix-login'));
  assert.ok(!isHotfixBranch('hotfix/7488'));
  assert.ok(!isHotfixBranch('hotfix/HR-7488-fix'));
});

test('what may merge into a release', () => {
  assert.ok(checkReleaseSource('rc/inbox', v('v2.16.0')).ok);
  assert.ok(!checkReleaseSource('hotfix/HR-1', v('v2.16.0')).ok);
  assert.ok(checkReleaseSource('hotfix/HR-1_x', v('v2.16.1')).ok);
  assert.ok(!checkReleaseSource('rc/inbox', v('v2.16.1')).ok);
  assert.ok(!checkReleaseSource('feature/HR-1', v('v2.16.0')).ok);
});
