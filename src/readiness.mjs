// "release-ready": may this release be deployed to production right now?
//  1. it contains the current tip of master, and
//  2. every lower release is merged into master, contained in this release,
//     or scrapped (scrapped releases have no branch, so they never show up).
import { parseReleaseBranch, compareVersions, formatVersion } from './versions.mjs';

export const READY_CONTEXT = 'release-ready';

export function evaluateReadiness(git, branch, mainBranch = 'master') {
  const version = parseReleaseBranch(branch);
  const problems = [];
  if (!git.isAncestor(`origin/${mainBranch}`, `origin/${branch}`)) {
    problems.push(`${mainBranch} has changes that are not in this release yet`);
  }
  const blocking = git
    .remoteBranches()
    .map((b) => ({ b, v: parseReleaseBranch(b) }))
    .filter((r) => r.v && compareVersions(r.v, version) < 0)
    .filter((r) => !git.isAncestor(`origin/${r.b}`, `origin/${mainBranch}`))
    .filter((r) => !git.isAncestor(`origin/${r.b}`, `origin/${branch}`))
    .sort((x, y) => compareVersions(x.v, y.v));
  if (blocking.length) {
    problems.push(`not merged or scrapped yet: ${blocking.map((r) => formatVersion(r.v)).join(', ')}`);
  }
  return { branch, ok: problems.length === 0, problems };
}

/** GitHub limits status descriptions to 140 characters. */
export function statusDescription(result) {
  const text = result.ok ? 'Ready to deploy to production' : `Not ready: ${result.problems.join('; ')}`;
  return text.length > 140 ? `${text.slice(0, 137)}...` : text;
}

/** Recalculates and publishes release-ready for every open release. */
export async function updateAllReadiness({ git, github, repository, mainBranch = 'master' }) {
  const results = [];
  for (const branch of git.remoteBranches().filter((b) => parseReleaseBranch(b))) {
    const result = evaluateReadiness(git, branch, mainBranch);
    await github.request('POST', `/repos/${repository}/statuses/${git.sha(`origin/${branch}`)}`, {
      state: result.ok ? 'success' : 'failure',
      context: READY_CONTEXT,
      description: statusDescription(result),
    });
    results.push(result);
  }
  return results.sort((a, b) => compareVersions(parseReleaseBranch(a.branch), parseReleaseBranch(b.branch)));
}

export function summarizeReadiness(results) {
  if (!results.length) return '## release-ready: no open release branches.';
  return [
    '## release-ready',
    '',
    '| Release | Ready to deploy | Why not |',
    '|---|---|---|',
    ...results.map((r) => `| \`${r.branch}\` | ${r.ok ? '✅ yes' : '⛔ no'} | ${r.problems.join('; ')} |`),
  ].join('\n');
}
