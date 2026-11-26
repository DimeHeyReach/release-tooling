// "Scrap release": the release won't ship (or shipped and went wrong, and we
// won't hotfix it). Allowed even if deployed. The number is burned forever.
import { parseVersion, formatVersion, releaseBranchName, scrappedTagName } from './versions.mjs';
import { findReleasePr } from './release-pr.mjs';
import { DEPLOYED_LABEL } from './deployed.mjs';

export async function scrapRelease({ git, github, repository, version: raw, mainBranch = 'master', actor = 'someone' }) {
  const version = parseVersion(raw?.startsWith('v') ? raw : `v${raw ?? ''}`);
  if (!version) throw new Error(`"${raw}" is not a version like v2.16.0.`);
  const branch = releaseBranchName(version);
  if (!git.remoteBranches().includes(branch)) throw new Error(`${branch} does not exist.`);

  const sha = git.sha(`origin/${branch}`);
  if (git.isReleaseMerged(`origin/${mainBranch}`, sha)) {
    throw new Error(`${branch} is already merged into ${mainBranch}; its code is there for good, so it can't be scrapped.`);
  }

  // Burn the number first: if anything later fails, the number is still safe.
  git.pushNewTag(sha, scrappedTagName(version));

  const pr = await findReleasePr(github, { repository, branch, mainBranch });
  let wasLive = false;
  if (pr) {
    const labels = (await github.request('GET', `/repos/${repository}/issues/${pr.number}/labels`)).map((l) => l.name);
    wasLive = labels.includes(DEPLOYED_LABEL);
    await github.request('POST', `/repos/${repository}/issues/${pr.number}/comments`, {
      body: `🗑️ ${formatVersion(version)} was scrapped by @${actor}. The number won't be used again.${wasLive ? '\n\n⚠️ It is still live in production: roll back in Microtica by redeploying the previous version.' : ''}`,
    });
    await github.request('PATCH', `/repos/${repository}/pulls/${pr.number}`, { state: 'closed' });
  }

  // PRs aimed at the release (RCs, hotfixes) are closed by GitHub when the branch goes; list them first.
  const incoming = (await github.request('GET', `/repos/${repository}/pulls?state=open&base=${encodeURIComponent(branch)}`))
    .map((p) => ({ number: p.number, head: p.head.ref }));

  git.deleteBranch(branch, sha);
  return { version: formatVersion(version), branch, sha, pr: pr?.number ?? null, wasLive, incoming };
}

export function summarizeScrap(r) {
  const lines = [`## 🗑️ Scrapped ${r.version}`, '', `- Marker \`scrapped/${r.version}\` created at \`${r.sha.slice(0, 7)}\`.`, `- Branch \`${r.branch}\` deleted.`];
  if (r.pr) lines.push(`- Release PR #${r.pr} closed.`);
  if (r.wasLive) lines.push('', '⚠️ **It is still live in production.** Roll back in Microtica by redeploying the previous version.');
  if (r.incoming.length) {
    lines.push('', 'These PRs were aimed at it and have been closed by GitHub. Point them at another release if they should still ship:');
    lines.push(...r.incoming.map((p) => `- #${p.number} \`${p.head}\``));
  }
  return lines.join('\n');
}
