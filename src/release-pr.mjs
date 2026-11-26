// The release → master pull request: open it once, keep it labelled.
import { parseReleaseBranch, formatVersion } from './versions.mjs';

export const CONFLICT_LABEL = 'release:conflict';
const MARKER = '<!-- release-tooling:conflict -->';

export function releasePrBody(branch, mainBranch) {
  const version = formatVersion(parseReleaseBranch(branch));
  return [
    `Release **${version}**. Opened automatically by the release bot.`,
    '',
    `This PR merges into \`${mainBranch}\` automatically once:`,
    '- the release is deployed to production (the `deployed` label), and',
    '- it has an approval.',
    '',
    `\`${mainBranch}\` is pulled into \`${branch}\` automatically whenever it changes.`,
  ].join('\n');
}

/** The open release → main PR, or null. Returns { number, nodeId }. */
export async function findReleasePr(github, { repository, branch, mainBranch }) {
  const owner = repository.split('/')[0];
  const open = await github.request(
    'GET',
    `/repos/${repository}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&base=${encodeURIComponent(mainBranch)}`,
  );
  return open.length ? { number: open[0].number, nodeId: open[0].node_id } : null;
}

/** Finds the open release → main PR, or opens it. Returns { number, nodeId, created }. */
export async function ensureReleasePr(github, { repository, branch, mainBranch }) {
  const existing = await findReleasePr(github, { repository, branch, mainBranch });
  if (existing) return { ...existing, created: false };
  const pr = await github.request('POST', `/repos/${repository}/pulls`, {
    title: `Release ${formatVersion(parseReleaseBranch(branch))}`,
    head: branch,
    base: mainBranch,
    body: releasePrBody(branch, mainBranch),
  });
  return { number: pr.number, nodeId: pr.node_id, created: true };
}

/**
 * Turns on auto-merge (merge commit). Needs "Allow auto-merge" in the repo
 * settings and at least one required check; returns an error message instead
 * of throwing so a missing setting doesn't fail the whole run.
 */
export async function enableAutoMerge(github, nodeId) {
  try {
    await github.request('POST', '/graphql', {
      query: `mutation($id: ID!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: MERGE }) { clientMutationId } }`,
      variables: { id: nodeId },
    }).then((res) => {
      if (res?.errors?.length) throw new Error(res.errors.map((e) => e.message).join('; '));
    });
    return null;
  } catch (err) {
    return err.message;
  }
}

/**
 * A flag on a PR: a label plus one explanatory comment when it's first raised.
 * `comment` = text to raise it (no-op if already raised), null = clear it.
 */
export async function setFlag(github, { repository, number, label, comment }) {
  const labels = (await github.request('GET', `/repos/${repository}/issues/${number}/labels`)).map((l) => l.name);
  const has = labels.includes(label);
  if (comment && !has) {
    await github.request('POST', `/repos/${repository}/issues/${number}/labels`, { labels: [label] });
    await github.request('POST', `/repos/${repository}/issues/${number}/comments`, { body: comment });
  } else if (!comment && has) {
    await github.request('DELETE', `/repos/${repository}/issues/${number}/labels/${encodeURIComponent(label)}`);
  }
  return Boolean(comment);
}

/** Adds or removes the conflict label, and comments with the files on a new conflict. */
export function setConflictState(github, { repository, number, branch, mainBranch, files }) {
  const comment = files && [
    MARKER,
    `⚠️ \`${mainBranch}\` could not be merged into \`${branch}\` automatically. Conflicting files:`,
    '',
    ...files.map((f) => `- \`${f}\``),
    '',
    `Fix it by merging \`${mainBranch}\` into \`${branch}\` locally, resolving the conflicts and pushing. The label is removed automatically once it's in sync.`,
  ].join('\n');
  return setFlag(github, { repository, number, label: CONFLICT_LABEL, comment });
}
