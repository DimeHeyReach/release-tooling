// Automations that run without anyone clicking:
//  - onReleaseMerge: an rc/* or hotfix/* PR was merged into a release
//  - syncAllReleases: master changed, pull it into every open release
import { parseReleaseBranch, isRcBranch, isHotfixBranch, compareVersions } from './versions.mjs';
import { findReleasePr, ensureReleasePr, enableAutoMerge, setConflictState } from './release-pr.mjs';

/** Pull main into one release and update its PR's conflict label. */
export async function syncRelease({ git, github, repository, branch, mainBranch, identity, pr }) {
  const result = git.mergeAndPush(mainBranch, branch, identity);
  pr ??= await findReleasePr(github, { repository, branch, mainBranch });
  if (pr) {
    await setConflictState(github, {
      repository, number: pr.number, branch, mainBranch,
      files: result.status === 'conflict' ? result.files : null,
    });
  }
  return { branch, ...result, pr: pr?.number ?? null };
}

/** Every open, not-yet-merged release branch, oldest first. */
export async function syncAllReleases({ git, github, repository, mainBranch, identity }) {
  const releases = git
    .remoteBranches()
    .map((b) => ({ b, v: parseReleaseBranch(b) }))
    .filter((r) => r.v)
    // Already shipped and merged: nothing to bring it up to date for.
    .filter((r) => !git.isReleaseMerged(`origin/${mainBranch}`, `origin/${r.b}`))
    .sort((x, y) => compareVersions(x.v, y.v))
    .map((r) => r.b);
  const results = [];
  for (const branch of releases) {
    try {
      results.push(await syncRelease({ git, github, repository, branch, mainBranch, identity }));
    } catch (err) {
      // One broken release must not stop the others from syncing.
      results.push({ branch, status: 'error', files: [], error: err.message });
    }
  }
  return results;
}

/** A PR into a release branch was closed. */
export async function onReleaseMerge({ git, github, repository, base, head, merged, mainBranch, identity, autoMerge = true }) {
  if (!merged) return { skipped: 'PR closed without merging.' };
  if (!parseReleaseBranch(base)) return { skipped: `${base} is not a release branch.` };

  let deleted = false;
  if (isRcBranch(head) || isHotfixBranch(head)) {
    try {
      await github.request('DELETE', `/repos/${repository}/git/refs/heads/${head}`);
      deleted = true;
    } catch {
      // Already deleted (e.g. "Automatically delete head branches" is on).
    }
  }

  const pr = await ensureReleasePr(github, { repository, branch: base, mainBranch });
  const sync = await syncRelease({ git, github, repository, branch: base, mainBranch, identity, pr });
  // Auto-merge only where the approval is enforced; otherwise it would merge
  // a deployed release with nobody approving it.
  const autoMergeError = autoMerge ? await enableAutoMerge(github, pr.nodeId) : null;
  return { deleted, head, pr: pr.number, prCreated: pr.created, sync, autoMerge, autoMergeError };
}

export function summarizeSync(results) {
  if (!results.length) return '## Nothing to sync: no open release branches.';
  const icon = { 'up-to-date': '✅ already up to date', merged: '🔀 master merged in', conflict: '⚠️ conflict', error: '❌ error' };
  return [
    '## Master pulled into open releases',
    '',
    '| Release | Result | Details |',
    '|---|---|---|',
    ...results.map((r) => `| \`${r.branch}\` | ${icon[r.status]} | ${r.status === 'conflict' ? r.files.map((f) => `\`${f}\``).join(', ') : r.error ?? ''} |`),
  ].join('\n');
}

export function summarizeReleaseMerge(r) {
  if (r.skipped) return `## Nothing to do. ${r.skipped}`;
  const lines = ['## Release updated', ''];
  if (r.deleted) lines.push(`- Deleted \`${r.head}\`.`);
  lines.push(`- ${r.prCreated ? 'Opened' : 'Using'} release PR #${r.pr}.`);
  lines.push(r.sync.status === 'conflict'
    ? `- ⚠️ master could not be merged in. Conflicts: ${r.sync.files.map((f) => `\`${f}\``).join(', ')}`
    : `- master: ${r.sync.status === 'merged' ? 'merged in' : 'already up to date'}.`);
  if (r.autoMerge === false) lines.push('- Auto-merge off (not in enforce mode): merge the release PR by hand once approved.');
  else lines.push(r.autoMergeError ? `- ⚠️ Auto-merge not enabled: ${r.autoMergeError}` : '- Auto-merge enabled.');
  return lines.join('\n');
}
