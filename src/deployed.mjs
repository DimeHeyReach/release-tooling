// Handles Microtica's "deployed" event (repository_dispatch, type "deployed",
// client_payload { version, sha, environment }).
//  - only production counts
//  - the deployed label moves to the release that is live now
//  - tag vX.Y.Z is created the first time a version is deployed
import { parseVersion, formatVersion, releaseBranchName } from './versions.mjs';
import { findReleasePr } from './release-pr.mjs';
import { writeDeployedSha, syncBehindFlag } from './behind.mjs';

export const DEPLOYED_LABEL = 'deployed';

export async function handleDeployed({ github, repository, payload, mainBranch = 'master' }) {
  const environment = String(payload?.environment ?? '');
  if (environment !== 'production') {
    return { ignored: `Environment is "${environment || 'missing'}", not production. Nothing changed.` };
  }
  const raw = String(payload?.version ?? '');
  const version = parseVersion(raw.startsWith('v') ? raw : `v${raw}`);
  if (!version) throw new Error(`"${raw}" is not a version like 2.16.0.`);
  const sha = String(payload?.sha ?? '');
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`"${sha}" is not a full commit SHA.`);

  const tag = formatVersion(version);
  const branch = releaseBranchName(version);
  const warnings = [];

  // The commit must belong to that release (its branch, or its tag if the
  // branch was cleaned up). If not, refuse: a wrong tag would be permanent.
  const hasBranch = await refExists(github, repository, `heads/${branch}`);
  if (!hasBranch && !(await refExists(github, repository, `tags/${tag}`))) {
    throw new Error(`${tag} has no release branch and no tag. Nothing was changed.`);
  }
  const target = hasBranch ? branch : tag;
  const cmp = await github.request('GET', `/repos/${repository}/compare/${sha}...${encodeURIComponent(target)}`);
  if (!['ahead', 'identical'].includes(cmp.status)) {
    throw new Error(`Commit ${sha.slice(0, 7)} is not part of ${target}. Nothing was changed.`);
  }

  // Tag on first deploy only.
  let tagCreated = false;
  if (!(await refExists(github, repository, `tags/${tag}`))) {
    await github.request('POST', `/repos/${repository}/git/refs`, { ref: `refs/tags/${tag}`, sha });
    tagCreated = true;
  }

  // Move the label: off every PR that has it, onto this release's PR.
  const labelled = await github.request('GET', `/repos/${repository}/issues?labels=${DEPLOYED_LABEL}&state=all`);
  const pr = await findReleasePr(github, { repository, branch, mainBranch });
  const removedFrom = [];
  for (const issue of labelled) {
    if (issue.number === pr?.number) continue;
    await github.request('DELETE', `/repos/${repository}/issues/${issue.number}/labels/${DEPLOYED_LABEL}`);
    removedFrom.push(issue.number);
  }
  if (pr && !labelled.some((i) => i.number === pr.number)) {
    await github.request('POST', `/repos/${repository}/issues/${pr.number}/labels`, { labels: [DEPLOYED_LABEL] });
  }
  if (!pr) warnings.push(`No open release PR for ${branch} (already merged, or never opened), so no label was added.`);

  // Remember exactly which commit is live, then raise or clear "behind production".
  let behind = false;
  if (pr) {
    const current = await github.request('GET', `/repos/${repository}/pulls/${pr.number}`);
    await github.request('PATCH', `/repos/${repository}/pulls/${pr.number}`, { body: writeDeployedSha(current.body, sha) });
    behind = (await syncBehindFlag(github, { repository, number: pr.number, deployedLabel: DEPLOYED_LABEL })).behind;
  }
  for (const number of removedFrom) await syncBehindFlag(github, { repository, number, deployedLabel: DEPLOYED_LABEL });

  return { version: tag, sha, tagCreated, pr: pr?.number ?? null, removedFrom, behind, warnings };
}

async function refExists(github, repository, ref) {
  try {
    await github.request('GET', `/repos/${repository}/git/ref/${ref}`);
    return true;
  } catch (err) {
    if (err.status === 404) return false;
    throw err;
  }
}

export function summarizeDeployed(r) {
  if (r.ignored) return `## Ignored. ${r.ignored}`;
  const lines = [`## 🚀 ${r.version} is live in production`, '', `- Commit \`${r.sha.slice(0, 7)}\`.`];
  lines.push(r.tagCreated ? `- Tag \`${r.version}\` created.` : `- Tag \`${r.version}\` already existed (redeploy or rollback).`);
  if (r.pr) lines.push(`- \`${DEPLOYED_LABEL}\` label is now on PR #${r.pr}.`);
  if (r.removedFrom.length) lines.push(`- Label removed from ${r.removedFrom.map((n) => `#${n}`).join(', ')}.`);
  if (r.behind) lines.push('- ℹ️ The release branch has newer commits than what was deployed (flagged on the PR).');
  for (const w of r.warnings) lines.push(`- ⚠️ ${w}`);
  return lines.join('\n');
}
