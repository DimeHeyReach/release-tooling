import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSourceCheck, runSourceCheck } from '../src/source-check.mjs';
import { createGitHub } from '../src/github.mjs';

const check = (base, head, extra = {}) => evaluateSourceCheck({ base, head, number: 10, ...extra });

test('into master: only release branches', () => {
  assert.ok(check('master', 'release/v2.16.0').ok);
  assert.ok(!check('master', 'rc/inbox').ok);
  assert.ok(!check('master', 'feature/HR-1').ok);
  assert.ok(!check('master', 'hotfix/HR-1').ok);
  assert.ok(check('main', 'release/v2.16.0', { mainBranch: 'main' }).ok);
});

test('into a minor release: only rc branches', () => {
  assert.ok(check('release/v2.16.0', 'rc/inbox').ok);
  const res = check('release/v2.16.0', 'feature/HR-1');
  assert.ok(!res.ok);
  assert.match(res.message, /only accept rc\/<name>/);
});

test('into a patch release: only hotfix branches', () => {
  assert.ok(check('release/v2.16.1', 'hotfix/HR-7488_login').ok);
  assert.ok(!check('release/v2.16.1', 'rc/inbox').ok);
  assert.ok(!check('release/v2.16.1', 'hotfix/7488').ok);
});

test('several RCs per release are allowed by default', () => {
  const merged = [{ number: 7, head: 'rc/first' }];
  assert.ok(check('release/v2.16.0', 'rc/second', { mergedIntoBase: merged }).ok);
});

test('one RC per release when singleRc is on', () => {
  const merged = [{ number: 7, head: 'rc/first' }];
  const res = check('release/v2.16.0', 'rc/second', { mergedIntoBase: merged, singleRc: true });
  assert.ok(!res.ok);
  assert.match(res.message, /already has an RC \(`rc\/first`, #7\)/);
});

test('the RC itself is not counted against its own release', () => {
  assert.ok(check('release/v2.16.0', 'rc/first', { number: 7, singleRc: true, mergedIntoBase: [{ number: 7, head: 'rc/first' }] }).ok);
});

test('merged master syncs do not count as an RC', () => {
  assert.ok(check('release/v2.16.0', 'rc/inbox', { singleRc: true, mergedIntoBase: [{ number: 3, head: 'master' }] }).ok);
});

test('patch releases may take several hotfixes', () => {
  const merged = [{ number: 7, head: 'hotfix/HR-1_a' }];
  assert.ok(check('release/v2.16.1', 'hotfix/HR-2_b', { mergedIntoBase: merged }).ok);
});

test('badly named release branches fail', () => {
  assert.match(check('release/2.16.0', 'rc/inbox').message, /not a valid release branch name/);
});

test('reads merged PRs from GitHub across pages', async () => {
  const calls = [];
  const page1 = Array.from({ length: 100 }, (_, i) => ({ number: i + 1, merged_at: i === 0 ? 'x' : null, head: { ref: `b${i}` } }));
  const page2 = [{ number: 500, merged_at: 'y', head: { ref: 'rc/old' } }];
  const fetchImpl = async (url) => {
    calls.push(url);
    const body = /[?&]page=1$/.test(url) ? page1 : page2;
    return { ok: true, status: 200, json: async () => body };
  };
  const gh = createGitHub({ token: 't', repository: 'HeyReach/demo', fetchImpl });
  const res = await runSourceCheck(gh, { base: 'release/v2.16.0', head: 'rc/new', number: 9, mainBranch: 'master', singleRc: true });
  assert.equal(calls.length, 2);
  assert.match(calls[0], /\/repos\/HeyReach\/demo\/pulls\?state=closed&base=release%2Fv2\.16\.0&per_page=100&page=1/);
  assert.ok(!res.ok);
  assert.match(res.message, /rc\/old/);
});

test('no GitHub call needed for master, patch targets, or when singleRc is off', async () => {
  const gh = { mergedPullsInto: async () => assert.fail('should not be called') };
  assert.ok((await runSourceCheck(gh, { base: 'release/v2.1.0', head: 'rc/x', mainBranch: 'master' })).ok);
  assert.ok((await runSourceCheck(gh, { base: 'master', head: 'release/v2.1.0', mainBranch: 'master' })).ok);
  assert.ok((await runSourceCheck(gh, { base: 'release/v2.1.1', head: 'hotfix/HR-1', mainBranch: 'master' })).ok);
});
