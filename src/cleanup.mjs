// Nightly cleanup: delete release branches merged into master more than
// `days` ago. Tags stay forever. A branch without its vX.Y.Z tag is never
// deleted, so no history is lost.
import { parseReleaseBranch, formatVersion, compareVersions } from './versions.mjs';

export function planCleanup({ git, mainBranch = 'master', days = 90, now = new Date() }) {
  const tags = new Set(git.tags());
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return git
    .remoteBranches()
    .map((branch) => ({ branch, version: parseReleaseBranch(branch) }))
    .filter((r) => r.version)
    .sort((a, b) => compareVersions(a.version, b.version))
    .map(({ branch, version }) => {
      const sha = git.sha(`origin/${branch}`);
      if (!git.isReleaseMerged(`origin/${mainBranch}`, sha)) return { branch, sha, action: 'keep', reason: 'not merged' };
      const mergedAt = git.mergedAt(git.mergeBase(sha, `origin/${mainBranch}`), mainBranch);
      if (!mergedAt) return { branch, sha, action: 'keep', reason: 'merge date unknown' };
      if (mergedAt > cutoff) return { branch, sha, action: 'keep', reason: `merged ${mergedAt.toISOString().slice(0, 10)}` };
      if (!tags.has(formatVersion(version))) return { branch, sha, action: 'keep', reason: `no ${formatVersion(version)} tag (run the migration)` };
      return { branch, sha, action: 'delete', reason: `merged ${mergedAt.toISOString().slice(0, 10)}` };
    });
}

export function runCleanup({ git, dryRun = false, ...options }) {
  const plan = planCleanup({ git, ...options });
  if (!dryRun) {
    for (const item of plan.filter((p) => p.action === 'delete')) {
      try {
        git.deleteBranch(item.branch, item.sha);
      } catch (err) {
        Object.assign(item, { action: 'keep', reason: `delete failed: ${err.message.split('\n')[0]}` });
      }
    }
  }
  return plan;
}

export function summarizeCleanup(plan, { dryRun, days }) {
  const deleting = plan.filter((p) => p.action === 'delete');
  return [
    `## ${dryRun ? 'Cleanup dry run' : 'Cleanup'}: ${deleting.length} release branch(es) ${dryRun ? 'would be' : ''} deleted`.replace('  ', ' '),
    '',
    `Rule: merged into master more than ${days} days ago, and tagged.`,
    '',
    '| Branch | Action | Why |',
    '|---|---|---|',
    ...plan.map((p) => `| \`${p.branch}\` | ${p.action === 'delete' ? (dryRun ? 'would delete' : '🗑️ deleted') : 'keep'} | ${p.reason} |`),
  ].join('\n');
}
