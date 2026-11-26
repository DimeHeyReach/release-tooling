import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { manageRepo, summarizeManage, workflowFiles, rulesets, INSTALL_BRANCH, RULESET_MAIN, RULESET_RELEASES } from '../src/manage.mjs';

const templatesDir = fileURLToPath(new URL('../templates', import.meta.url));
const repo = 'DimeHeyReach/release-tooling-demo';

/** A tiny GitHub for the repo-management endpoints. */
function fakeRepo({ files = {}, rulesetsForbidden = false, rulesetsUnavailable = false, existing = [] } = {}) {
  const s = { variables: {}, labels: [], settings: {}, files: { ...files }, branchFiles: {}, refs: { master: 'm'.repeat(40) },
    pulls: [], rulesets: existing.map((r, i) => ({ id: i + 1, ...r })), calls: [] };
  const err = (status) => Object.assign(new Error(String(status)), { status });
  const request = async (method, path, body) => {
    s.calls.push(`${method} ${path}`);
    let m;
    const p = path.replace(`/repos/${repo}`, '');
    if ((m = p.match(/^\/actions\/variables\/(\w+)$/)) && method === 'PATCH') {
      if (!(m[1] in s.variables)) throw err(404);
      s.variables[m[1]] = body.value; return null;
    }
    if (p === '/actions/variables' && method === 'POST') { s.variables[body.name] = body.value; return null; }
    if (p === '/labels' && method === 'POST') { if (s.labels.includes(body.name)) throw err(422); s.labels.push(body.name); return {}; }
    if (p.startsWith('/labels/') && method === 'PATCH') return {};
    if (p === '' && method === 'PATCH') { Object.assign(s.settings, body); return {}; }
    if ((m = p.match(/^\/contents\/(.+)\?ref=(.+)$/)) && method === 'GET') {
      const ref = decodeURIComponent(m[2]);
      const store = ref === 'master' ? s.files : s.branchFiles;
      if (!(m[1] in store)) throw err(404);
      return { content: Buffer.from(store[m[1]]).toString('base64'), sha: 'x' };
    }
    if ((m = p.match(/^\/contents\/(.+)$/)) && method === 'PUT') { s.branchFiles[m[1]] = Buffer.from(body.content, 'base64').toString(); return {}; }
    if (p === '/git/ref/heads/master') return { object: { sha: s.refs.master } };
    if (p === '/git/refs' && method === 'POST') { if (s.refs[INSTALL_BRANCH]) throw err(422); s.refs[INSTALL_BRANCH] = body.sha; return {}; }
    if (p === `/git/refs/heads/${INSTALL_BRANCH}` && method === 'PATCH') { s.refs[INSTALL_BRANCH] = body.sha; return {}; }
    if (p.startsWith('/pulls?state=open') && method === 'GET') return s.pulls.filter((x) => x.state === 'open');
    if (p === '/pulls' && method === 'POST') { const pr = { number: s.pulls.length + 1, state: 'open', ...body }; s.pulls.push(pr); return pr; }
    if (p === '/rulesets' && method === 'GET') { if (rulesetsUnavailable) throw err(403); return s.rulesets; }
    if (p === '/rulesets' && method === 'POST') { if (rulesetsForbidden) throw err(403); s.rulesets.push({ id: s.rulesets.length + 10, ...body }); return {}; }
    if ((m = p.match(/^\/rulesets\/(\d+)$/))) {
      if (method === 'PUT') { Object.assign(s.rulesets.find((r) => r.id === Number(m[1])), body); return {}; }
      if (method === 'DELETE') { s.rulesets = s.rulesets.filter((r) => r.id !== Number(m[1])); return null; }
    }
    throw new Error(`no route ${method} ${path}`);
  };
  return { request, s };
}

const run = (gh, mode, extra = {}) => manageRepo({ github: gh, repo, mode, templatesDir, appId: '12345', ...extra });

test('templates get the right owner and the on/off guard', () => {
  const files = workflowFiles(templatesDir, 'DimeHeyReach');
  assert.deepEqual(files.map((f) => f.path), [
    '.github/workflows/cleanup-releases.yml', '.github/workflows/create-release.yml', '.github/workflows/deployed.yml',
    '.github/workflows/release-automation.yml', '.github/workflows/scrap-release.yml', '.github/workflows/source-check.yml',
  ]);
  for (const f of files) {
    assert.match(f.content, /uses: DimeHeyReach\/release-tooling\//, f.path);
    assert.doesNotMatch(f.content, /uses: HeyReach\//, f.path);
    assert.match(f.content, /vars\.RELEASE_TOOLING_MODE/, f.path);
  }
  assert.ok(workflowFiles(templatesDir, 'x', { demo: true }).some((f) => f.path.endsWith('simulate-deploy.yml')));
});

test('warn: variable set, labels, settings, install PR, no rulesets', async () => {
  const gh = fakeRepo();
  const r = await run(gh, 'warn');
  assert.equal(gh.s.variables.RELEASE_TOOLING_MODE, 'warn');
  assert.deepEqual(gh.s.labels, ['deployed', 'release:conflict', 'release:behind-production']);
  assert.deepEqual(gh.s.settings, { allow_auto_merge: true, allow_merge_commit: true });
  assert.equal(gh.s.pulls.length, 1);
  assert.equal(gh.s.pulls[0].head, INSTALL_BRANCH);
  assert.equal(Object.keys(gh.s.branchFiles).length, 6);
  assert.deepEqual(gh.s.rulesets, []);
  assert.match(summarizeManage(r), /warn \(reports only\)[\s\S]*PR #1 \(6 file\(s\)\)[\s\S]*Merge PR #1/);
});

test('files already installed: no PR', async () => {
  const files = Object.fromEntries(workflowFiles(templatesDir, 'DimeHeyReach').map((f) => [f.path, f.content]));
  const gh = fakeRepo({ files });
  const r = await run(gh, 'warn');
  assert.equal(r.install.pr, null);
  assert.equal(gh.s.pulls.length, 0);
  assert.match(summarizeManage(r), /already up to date/);
});

test('only changed files go into the PR; running twice reuses it', async () => {
  const all = workflowFiles(templatesDir, 'DimeHeyReach');
  const files = Object.fromEntries(all.map((f) => [f.path, f.content]));
  files['.github/workflows/deployed.yml'] = 'old version';
  const gh = fakeRepo({ files });
  const r = await run(gh, 'warn');
  assert.deepEqual(r.install.changed, ['.github/workflows/deployed.yml']);
  await run(gh, 'warn');
  assert.equal(gh.s.pulls.length, 1);
  assert.ok(!gh.s.calls.some((c) => c.startsWith('PATCH') && c.includes('/git/refs/')), 'never resets the install branch (GitHub would close the PR)');
});

test('enforce: both rulesets created, bot can bypass on release branches only', async () => {
  const gh = fakeRepo();
  await run(gh, 'enforce');
  assert.equal(gh.s.variables.RELEASE_TOOLING_MODE, 'enforce');
  const byName = Object.fromEntries(gh.s.rulesets.map((r) => [r.name, r]));
  assert.deepEqual(byName[RULESET_MAIN].bypass_actors, []);
  assert.deepEqual(byName[RULESET_RELEASES].bypass_actors, [{ actor_id: 12345, actor_type: 'Integration', bypass_mode: 'always' }]);
  const checks = (rs) => rs.rules.find((x) => x.type === 'required_status_checks').parameters.required_status_checks.map((c) => c.context);
  assert.deepEqual(checks(byName[RULESET_MAIN]), ['source / Release source check', 'source / Release merge gate']);
  assert.deepEqual(checks(byName[RULESET_RELEASES]), ['source / Release source check']);
  assert.ok(byName[RULESET_RELEASES].rules.some((x) => x.type === 'creation'), 'only the bot can create release branches');
});

test('enforce twice updates instead of duplicating; back to warn removes them', async () => {
  const gh = fakeRepo();
  await run(gh, 'enforce');
  await run(gh, 'enforce');
  assert.equal(gh.s.rulesets.length, 2);
  await run(gh, 'warn');
  assert.deepEqual(gh.s.rulesets, []);
});

test('off: variable off, our rulesets removed, other rulesets and files untouched', async () => {
  const gh = fakeRepo({ existing: [
    { name: RULESET_MAIN }, { name: 'team: something else' },
  ] });
  const r = await run(gh, 'off');
  assert.equal(gh.s.variables.RELEASE_TOOLING_MODE, 'off');
  assert.deepEqual(gh.s.rulesets.map((x) => x.name), ['team: something else']);
  assert.equal(gh.s.pulls.length, 0);
  assert.ok(!gh.s.calls.some((c) => c.startsWith('PUT') || c.includes('/labels')));
  assert.match(summarizeManage(r), /off/);
});

test('rulesets refused on a free private repo: clear explanation, rest still applied', async () => {
  const gh = fakeRepo({ rulesetsForbidden: true });
  const r = await run(gh, 'enforce');
  assert.equal(gh.s.variables.RELEASE_TOOLING_MODE, 'enforce');
  assert.match(r.notes[0], /free personal plan/);
});

test('unknown mode is refused', async () => {
  await assert.rejects(run(fakeRepo(), 'on'), /Unknown mode/);
});

test('rulesets use the configured default branch', () => {
  const [main] = rulesets({ appId: 1, mainBranch: 'main' });
  assert.deepEqual(main.conditions.ref_name.include, ['refs/heads/main']);
});

test('warn and off still work where the plan has no rulesets at all', async () => {
  for (const mode of ['warn', 'off']) {
    const gh = fakeRepo({ rulesetsUnavailable: true });
    const r = await run(gh, mode);
    assert.equal(gh.s.variables.RELEASE_TOOLING_MODE, mode);
    assert.match(r.notes[0], /not available for this repo on its current plan/);
  }
  const r = await run(fakeRepo({ rulesetsUnavailable: true }), 'enforce');
  assert.match(r.notes[0], /free personal plan/);
});
