// "Manage repo": turn the release process on, to warn-only, or off for one repo.
//
//   off      everything skipped (workflows check RELEASE_TOOLING_MODE)
//   warn     everything runs and reports; nothing blocks merges
//   enforce  warn + branch rulesets that make the checks block merges
//
// Installing the workflow files is done through a pull request, so it works
// on repos with a protected default branch and someone always reviews it.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { INSTALL_BRANCH } from './tooling-update.mjs';

export { INSTALL_BRANCH };

export const MODES = ['off', 'warn', 'enforce'];
export const MODE_VARIABLE = 'RELEASE_TOOLING_MODE';
export const RULESET_MAIN = 'release-tooling: default branch';
export const RULESET_RELEASES = 'release-tooling: release branches';

export const LABELS = [
  { name: 'deployed', color: '1f883d', description: 'This release is live in production right now' },
  { name: 'release:conflict', color: 'd1242f', description: 'master could not be merged into this release automatically' },
  { name: 'release:behind-production', color: 'bf8700', description: 'The release branch has commits newer than what is deployed' },
];

/** The caller workflow files every product repo gets, with the owner filled in. */
export function workflowFiles(templatesDir, owner, { demo = false } = {}) {
  return readdirSync(templatesDir)
    .filter((f) => f.endsWith('.yml') && (demo || f !== 'simulate-deploy.yml'))
    .sort()
    .map((f) => ({
      path: `.github/workflows/${f}`,
      content: readFileSync(join(templatesDir, f), 'utf8').replaceAll('HeyReach/release-tooling', `${owner}/release-tooling`),
    }));
}

/** Branch rulesets for enforce mode. The bot may bypass so it can sync master into releases. */
export function rulesets({ appId, mainBranch = 'master' }) {
  const bypass = appId ? [{ actor_id: Number(appId), actor_type: 'Integration', bypass_mode: 'always' }] : [];
  return [
    {
      name: RULESET_MAIN,
      target: 'branch',
      enforcement: 'active',
      bypass_actors: [],
      conditions: { ref_name: { include: [`refs/heads/${mainBranch}`], exclude: [] } },
      rules: [
        { type: 'deletion' },
        { type: 'non_fast_forward' },
        {
          type: 'pull_request',
          parameters: {
            required_approving_review_count: 1,
            dismiss_stale_reviews_on_push: false,
            require_code_owner_review: false,
            require_last_push_approval: false,
            required_review_thread_resolution: false,
            allowed_merge_methods: ['merge'],
          },
        },
        {
          type: 'required_status_checks',
          parameters: {
            strict_required_status_checks_policy: false,
            required_status_checks: [{ context: 'source / Release source check' }, { context: 'source / Release merge gate' }],
          },
        },
      ],
    },
    {
      name: RULESET_RELEASES,
      target: 'branch',
      enforcement: 'active',
      bypass_actors: bypass,
      conditions: { ref_name: { include: ['refs/heads/release/**'], exclude: [] } },
      rules: [
        { type: 'creation' },
        { type: 'deletion' },
        { type: 'non_fast_forward' },
        {
          type: 'pull_request',
          parameters: {
            required_approving_review_count: 0,
            dismiss_stale_reviews_on_push: false,
            require_code_owner_review: false,
            require_last_push_approval: false,
            required_review_thread_resolution: false,
            allowed_merge_methods: ['merge'],
          },
        },
        {
          type: 'required_status_checks',
          parameters: {
            strict_required_status_checks_policy: false,
            required_status_checks: [{ context: 'source / Release source check' }],
          },
        },
      ],
    },
  ];
}

const isNotFound = (err) => err.status === 404;

async function setVariable(github, repo, value) {
  try {
    await github.request('PATCH', `/repos/${repo}/actions/variables/${MODE_VARIABLE}`, { name: MODE_VARIABLE, value });
  } catch (err) {
    if (!isNotFound(err)) throw err;
    await github.request('POST', `/repos/${repo}/actions/variables`, { name: MODE_VARIABLE, value });
  }
}

async function ensureLabels(github, repo) {
  for (const label of LABELS) {
    try {
      await github.request('POST', `/repos/${repo}/labels`, label);
    } catch (err) {
      if (err.status !== 422) throw err; // 422 = already exists
      await github.request('PATCH', `/repos/${repo}/labels/${encodeURIComponent(label.name)}`, label);
    }
  }
}

/** Opens (or updates) a PR with any workflow files that are missing or out of date. */
async function installFiles(github, repo, files, mainBranch) {
  const changed = [];
  for (const file of files) {
    let current = null;
    try {
      const res = await github.request('GET', `/repos/${repo}/contents/${file.path}?ref=${encodeURIComponent(mainBranch)}`);
      current = Buffer.from(res.content, 'base64').toString('utf8');
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    if (current !== file.content) changed.push(file);
  }
  if (!changed.length) return { pr: null, changed: [] };

  const base = await github.request('GET', `/repos/${repo}/git/ref/heads/${mainBranch}`);
  try {
    await github.request('POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${INSTALL_BRANCH}`, sha: base.object.sha });
  } catch (err) {
    // Branch exists from an earlier run: keep it and update the files on it.
    // (Resetting it would leave the open PR empty for a moment, and GitHub closes empty PRs.)
    if (err.status !== 422) throw err;
  }
  for (const file of changed) {
    let sha;
    try {
      sha = (await github.request('GET', `/repos/${repo}/contents/${file.path}?ref=${encodeURIComponent(INSTALL_BRANCH)}`)).sha;
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    await github.request('PUT', `/repos/${repo}/contents/${file.path}`, {
      message: `Install release-tooling: ${file.path}`,
      content: Buffer.from(file.content).toString('base64'),
      branch: INSTALL_BRANCH,
      ...(sha ? { sha } : {}),
    });
  }
  const owner = repo.split('/')[0];
  const open = await github.request('GET', `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${INSTALL_BRANCH}`)}&base=${encodeURIComponent(mainBranch)}`);
  if (open.length) return { pr: open[0].number, changed: changed.map((f) => f.path) };
  const pr = await github.request('POST', `/repos/${repo}/pulls`, {
    title: 'Install release-tooling workflows',
    head: INSTALL_BRANCH,
    base: mainBranch,
    body: `Adds or updates the release process workflows:\n\n${changed.map((f) => `- \`${f.path}\``).join('\n')}\n\nOpened by the Manage repo workflow in release-tooling.`,
  });
  return { pr: pr.number, changed: changed.map((f) => f.path) };
}

async function applyRulesets(github, repo, wanted, mode) {
  const existing = await github.request('GET', `/repos/${repo}/rulesets`);
  const ours = new Map(existing.filter((r) => r.name.startsWith('release-tooling: ')).map((r) => [r.name, r.id]));
  const done = [];
  if (mode === 'enforce') {
    for (const ruleset of wanted) {
      if (ours.has(ruleset.name)) {
        await github.request('PUT', `/repos/${repo}/rulesets/${ours.get(ruleset.name)}`, ruleset);
        done.push(`updated "${ruleset.name}"`);
      } else {
        await github.request('POST', `/repos/${repo}/rulesets`, ruleset);
        done.push(`created "${ruleset.name}"`);
      }
    }
  } else {
    for (const [name, id] of ours) {
      await github.request('DELETE', `/repos/${repo}/rulesets/${id}`);
      done.push(`removed "${name}"`);
    }
  }
  return done;
}

/**
 * Leaving enforce removes the required approval. Any release PR with auto-merge
 * on would then merge by itself, so switch auto-merge off on them first.
 */
async function setReleaseAutoMerge(github, repo, mainBranch, on) {
  const open = await github.request('GET', `/repos/${repo}/pulls?state=open&base=${encodeURIComponent(mainBranch)}`);
  const numbers = [];
  for (const pr of open.filter((p) => p.head.ref.startsWith('release/') && Boolean(p.auto_merge) !== on)) {
    const res = await github.request('POST', '/graphql', {
      query: on
        ? 'mutation($id: ID!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: MERGE }) { clientMutationId } }'
        : 'mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId } }',
      variables: { id: pr.node_id },
    });
    if (!res?.errors?.length) numbers.push(pr.number);
  }
  return numbers;
}

export async function manageRepo({ github, repo, mode, templatesDir, appId, mainBranch = 'master', demo = false }) {
  if (!MODES.includes(mode)) throw new Error(`Unknown mode "${mode}". Use ${MODES.join(', ')}.`);
  const result = { repo, mode, install: null, rulesets: [], notes: [], autoMergeOff: [], autoMergeOn: [] };

  if (mode !== 'enforce') result.autoMergeOff = await setReleaseAutoMerge(github, repo, mainBranch, false);

  if (mode !== 'off') {
    await ensureLabels(github, repo);
    const settings = await github.request('PATCH', `/repos/${repo}`, { allow_auto_merge: true, allow_merge_commit: true });
    // GitHub silently ignores allow_auto_merge where the plan doesn't support it (e.g. free private repos).
    if (settings && settings.allow_auto_merge === false) {
      result.notes.push('GitHub did not allow auto-merge on this repo (its plan does not support it): approved release PRs must be merged by hand.');
    }
    result.install = await installFiles(github, repo, workflowFiles(templatesDir, repo.split('/')[0], { demo }), mainBranch);
  }
  await setVariable(github, repo, mode);
  try {
    result.rulesets = await applyRulesets(github, repo, rulesets({ appId, mainBranch }), mode);
  } catch (err) {
    if (err.status !== 403 && mode !== 'enforce') throw err;
    if (err.status === 403 && mode !== 'enforce') {
      // Rulesets not available on this plan: nothing to remove, warn/off still work.
      result.notes.push('Branch rulesets are not available for this repo on its current plan; enforce mode will not work here.');
    } else {
      result.notes.push(err.status === 403
        ? 'GitHub refused the branch rulesets (403). Private repos on a free personal plan cannot use them: make the repo public or upgrade the plan.'
        : `Rulesets failed: ${err.message}`);
    }
  }
  // Back in enforce (approval required again): restore auto-merge on open release PRs.
  if (mode === 'enforce' && result.rulesets.length) result.autoMergeOn = await setReleaseAutoMerge(github, repo, mainBranch, true);
  if (result.install?.pr) result.notes.push(`Merge PR #${result.install.pr} to finish installing the workflows.`);
  return result;
}

export function summarizeManage(r) {
  const label = { off: '⏸️ off', warn: '👀 warn (reports only)', enforce: '🔒 enforce (blocks merges)' }[r.mode];
  const lines = [`## ${r.repo}: ${label}`, '', `- \`${MODE_VARIABLE}\` = \`${r.mode}\`.`];
  if (r.install) {
    lines.push(r.install.pr
      ? `- Workflow files: PR #${r.install.pr} (${r.install.changed.length} file(s)).`
      : '- Workflow files: already up to date.');
    lines.push('- Labels created; merge commits allowed; auto-merge requested.');
  }
  if (r.autoMergeOff.length) lines.push(`- Auto-merge turned off on release PR ${r.autoMergeOff.map((n) => `#${n}`).join(', ')} (no approval is required outside enforce).`);
  for (const r2 of r.rulesets) lines.push(`- Ruleset ${r2}.`);
  if (r.autoMergeOn.length) lines.push(`- Auto-merge turned back on for release PR ${r.autoMergeOn.map((n) => `#${n}`).join(', ')}.`);
  if (r.mode !== 'enforce' && !r.rulesets.length) lines.push('- No rulesets (nothing blocks merges).');
  for (const n of r.notes) lines.push(`- ⚠️ ${n}`);
  return lines.join('\n');
}
