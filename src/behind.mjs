// "Behind production": the release that is live has newer commits on its
// branch than the commit actually deployed. The deployed commit is recorded
// in a hidden marker in the release PR's description by the deployed handler.
import { setFlag } from './release-pr.mjs';

export const BEHIND_LABEL = 'release:behind-production';
const SHA_MARKER_RE = /<!-- release-tooling:deployed-sha=([0-9a-f]{40}) -->/;

export function readDeployedSha(body) {
  return SHA_MARKER_RE.exec(body ?? '')?.[1] ?? null;
}

export function writeDeployedSha(body, sha) {
  const marker = `<!-- release-tooling:deployed-sha=${sha} -->`;
  const text = body ?? '';
  return SHA_MARKER_RE.test(text) ? text.replace(SHA_MARKER_RE, marker) : `${text}\n\n${marker}`.trimStart();
}

/**
 * Raises or clears the flag on one PR. Only a PR with the deployed label can
 * be behind; anything else gets the flag cleared.
 */
export async function syncBehindFlag(github, { repository, number, deployedLabel = 'deployed' }) {
  const pr = await github.request('GET', `/repos/${repository}/pulls/${number}`);
  const live = pr.labels.some((l) => l.name === deployedLabel);
  const deployedSha = readDeployedSha(pr.body);
  const headSha = pr.head.sha;
  const behind = live && deployedSha && deployedSha !== headSha;
  const comment = behind && [
    '<!-- release-tooling:behind -->',
    `ℹ️ Production is behind \`${pr.head.ref}\`.`,
    '',
    `- Deployed: \`${deployedSha.slice(0, 7)}\``,
    `- Branch now: \`${headSha.slice(0, 7)}\``,
    `- Difference: https://github.com/${repository}/compare/${deployedSha}...${headSha}`,
    '',
    'Redeploy to bring production up to date. The label is removed automatically when the latest commit is deployed.',
  ].join('\n');
  await setFlag(github, { repository, number, label: BEHIND_LABEL, comment });
  return { number, behind: Boolean(behind), deployedSha, headSha };
}

/** Checks every open PR that is live or currently flagged. */
export async function syncAllBehindFlags(github, { repository, deployedLabel = 'deployed' }) {
  const numbers = new Set();
  for (const label of [deployedLabel, BEHIND_LABEL]) {
    for (const issue of await github.request('GET', `/repos/${repository}/issues?labels=${encodeURIComponent(label)}&state=open`)) {
      numbers.add(issue.number);
    }
  }
  const results = [];
  for (const number of numbers) results.push(await syncBehindFlag(github, { repository, number, deployedLabel }));
  return results;
}
