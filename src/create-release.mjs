// "Create release": work out the version, check for unmerged releases,
// pick the starting point and create release/vX.Y.Z on origin.
import {
  usedVersions, nextVersion, parseVersion, formatVersion, compareVersions,
  parseReleaseBranch, releaseBranchName,
} from './versions.mjs';

/** Open release branches whose tip is not in the main branch yet. */
export function findUnmergedReleases(git, mainBranch) {
  return git
    .remoteBranches()
    .map((b) => ({ branch: b, version: parseReleaseBranch(b) }))
    .filter((r) => r.version && !git.isReleaseMerged(`origin/${mainBranch}`, `origin/${r.branch}`))
    .sort((a, b) => compareVersions(a.version, b.version))
    .map((r) => r.branch);
}

/**
 * Where a patch release starts: the newest existing release in that line
 * (its branch if it still exists, otherwise its tag). Scrapped versions have
 * neither, so they are skipped automatically.
 */
function patchBase(git, patchOf) {
  const branches = new Set(git.remoteBranches());
  const tags = new Set(git.tags());
  const candidates = usedVersions({ branches: [...branches], tags: [...tags] })
    .filter((v) => v.major === patchOf.major && v.minor === patchOf.minor)
    .reverse();
  for (const v of candidates) {
    if (branches.has(releaseBranchName(v))) return `origin/${releaseBranchName(v)}`;
    if (tags.has(formatVersion(v))) return formatVersion(v);
  }
  throw new Error(`Nothing left to patch in the ${patchOf.major}.${patchOf.minor} line.`);
}

/** Works out everything without changing anything. */
export function planCreateRelease(git, { bump, patchOf, mainBranch = 'master' }) {
  const used = usedVersions({ branches: git.remoteBranches(), tags: git.tags() });
  let patchVersion = null;
  if (bump === 'patch') {
    patchVersion = parseVersion(patchOf?.startsWith('v') ? patchOf : `v${patchOf ?? ''}`);
    if (!patchVersion) throw new Error(`"${patchOf}" is not a version like v2.16.0.`);
  }
  const version = nextVersion(bump, used, patchVersion);
  const branch = releaseBranchName(version);
  const baseRef = bump === 'patch' ? patchBase(git, patchVersion) : `origin/${mainBranch}`;
  return {
    version: formatVersion(version),
    branch,
    baseRef,
    baseSha: git.sha(baseRef),
    unmerged: findUnmergedReleases(git, mainBranch),
  };
}

/**
 * Runs the plan. Returns { created: false, plan } when unmerged releases
 * exist and the caller didn't choose to proceed anyway.
 */
export function createRelease(git, options) {
  const plan = planCreateRelease(git, options);
  if (plan.unmerged.length && !options.proceedWithUnmerged) return { created: false, plan };
  git.pushNewBranch(plan.baseSha, plan.branch);
  return { created: true, plan };
}

/** Markdown for the workflow run summary. */
export function summarize({ created, plan }) {
  const lines = [];
  if (created) {
    lines.push(`## ✅ Created \`${plan.branch}\``, '', `Cut from \`${plan.baseRef}\` at \`${plan.baseSha.slice(0, 7)}\`.`);
  } else {
    lines.push(`## ⛔ Not created: \`${plan.branch}\``, '', 'These releases are not merged into master yet:');
  }
  if (plan.unmerged.length) {
    if (created) lines.push('', '⚠️ Created anyway, although these releases are not merged into master yet:');
    lines.push('', ...plan.unmerged.map((b) => `- \`${b}\``));
  }
  if (!created) lines.push('', 'To create it anyway, run the workflow again with **Proceed with unmerged releases** ticked.');
  return lines.join('\n');
}
