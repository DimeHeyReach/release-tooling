// One-time migration per repo, so the system starts from correct history.
//  1. Every release ever merged into master is found from master's merge
//     commits ("Merge ... release/v2.14.0 ..."), even if its branch is long
//     gone, and tagged vX.Y.Z at the exact commit that was merged.
//  2. Open release branches already merged into master are tagged too.
//  3. Open release branches NOT merged are listed for a person to decide:
//     keep them, or scrap them (pass their versions in `scrap`).
import { parseVersion, formatVersion, compareVersions, parseReleaseBranch, scrappedTagName } from './versions.mjs';

const MERGED_RELEASE_RE = /release\/(v\d+\.\d+\.\d+)\b/;

export function planMigration({ git, mainBranch = 'master', scrap = [] }) {
  const tags = new Set(git.tags());
  const toTag = new Map(); // version -> { sha, source }

  for (const m of git.merges(mainBranch)) {
    const version = parseVersion(MERGED_RELEASE_RE.exec(m.subject)?.[1] ?? '');
    if (!version || !m.secondParent) continue;
    const tag = formatVersion(version);
    // Newest first: if a release was merged more than once, its latest
    // (most complete) merge wins.
    if (!tags.has(tag) && !toTag.has(tag)) toTag.set(tag, { version, sha: m.secondParent, source: `merge ${m.sha.slice(0, 7)}` });
  }

  const unmerged = [];
  for (const branch of git.remoteBranches()) {
    const version = parseReleaseBranch(branch);
    if (!version) continue;
    const tag = formatVersion(version);
    const sha = git.sha(`origin/${branch}`);
    if (git.isReleaseMerged(`origin/${mainBranch}`, sha)) {
      if (!tags.has(tag) && !toTag.has(tag)) toTag.set(tag, { version, sha: git.mergeBase(sha, `origin/${mainBranch}`), source: `branch ${branch}` });
    } else {
      unmerged.push({ branch, version, sha, decision: scrap.includes(tag) ? 'scrap' : 'keep open' });
    }
  }

  const wanted = new Set(scrap);
  for (const u of unmerged) wanted.delete(formatVersion(u.version));
  if (wanted.size) throw new Error(`Asked to scrap ${[...wanted].join(', ')}, but those are not open, unmerged release branches.`);

  return {
    tags: [...toTag.entries()].map(([tag, t]) => ({ tag, ...t })).sort((a, b) => compareVersions(a.version, b.version)),
    unmerged: unmerged.sort((a, b) => compareVersions(a.version, b.version)),
  };
}

/** Applies the plan. Scrapping here only burns the number and deletes the branch. */
export function applyMigration({ git, plan }) {
  for (const t of plan.tags) git.pushNewTag(t.sha, t.tag);
  for (const u of plan.unmerged.filter((x) => x.decision === 'scrap')) {
    git.pushNewTag(u.sha, scrappedTagName(u.version));
    git.deleteBranch(u.branch, u.sha);
  }
}

export function summarizeMigration(plan, { dryRun }) {
  const lines = [`## Migration ${dryRun ? 'dry run (nothing changed)' : 'applied'}`, ''];
  lines.push(`### Version tags ${dryRun ? 'to create' : 'created'}: ${plan.tags.length}`, '');
  if (plan.tags.length) {
    lines.push('| Tag | Commit | Found from |', '|---|---|---|', ...plan.tags.map((t) => `| \`${t.tag}\` | \`${t.sha.slice(0, 7)}\` | ${t.source} |`));
  } else {
    lines.push('Nothing to tag: history is already complete.');
  }
  lines.push('', '### Open release branches not merged into master', '');
  if (plan.unmerged.length) {
    lines.push('| Branch | Decision |', '|---|---|', ...plan.unmerged.map((u) => `| \`${u.branch}\` | ${u.decision === 'scrap' ? '🗑️ scrap' : 'keep open'} |`));
    if (dryRun) {
      const example = plan.unmerged.slice(0, 2).map((u) => formatVersion(u.version)).join(', ');
      lines.push('', `To scrap some of these, run again with their versions in **Scrap** (comma-separated), e.g. \`${example}\`.`);
    }
  } else {
    lines.push('None.');
  }
  return lines.join('\n');
}
