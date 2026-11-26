// Version and branch-name rules for the HeyReach release process.
// Pure functions only: no git, no network. Everything else builds on these.

const VERSION_RE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const RELEASE_PREFIX = 'release/';
export const SCRAPPED_PREFIX = 'scrapped/';
export const RC_RE = /^rc\/[A-Za-z0-9._-]+$/;
export const HOTFIX_RE = /^hotfix\/HR-[1-9]\d*(_[A-Za-z0-9._-]+)?$/;

/** "v2.15.1" -> { major: 2, minor: 15, patch: 1 }, anything else -> null. */
export function parseVersion(text) {
  const m = VERSION_RE.exec(text);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function formatVersion(v) {
  return `v${v.major}.${v.minor}.${v.patch}`;
}

export function compareVersions(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function releaseBranchName(v) {
  return `${RELEASE_PREFIX}${formatVersion(v)}`;
}

export function scrappedTagName(v) {
  return `${SCRAPPED_PREFIX}${formatVersion(v)}`;
}

/** "release/v2.15.1" -> version, or null if the name doesn't follow the rule. */
export function parseReleaseBranch(name) {
  return name.startsWith(RELEASE_PREFIX) ? parseVersion(name.slice(RELEASE_PREFIX.length)) : null;
}

export const isRcBranch = (name) => RC_RE.test(name);
export const isHotfixBranch = (name) => HOTFIX_RE.test(name);

/**
 * Every version number that has ever been used, from:
 *  - release branches  (release/vX.Y.Z, open or not yet cleaned up)
 *  - release tags      (vX.Y.Z, created on first production deploy)
 *  - scrapped markers  (scrapped/vX.Y.Z)
 * Numbers are never reused, so all three count. Unknown names are ignored.
 */
export function usedVersions({ branches = [], tags = [] }) {
  const seen = new Map();
  const add = (v) => v && seen.set(formatVersion(v), v);
  for (const b of branches) add(parseReleaseBranch(b));
  for (const t of tags) {
    add(t.startsWith(SCRAPPED_PREFIX) ? parseVersion(t.slice(SCRAPPED_PREFIX.length)) : parseVersion(t));
  }
  return [...seen.values()].sort(compareVersions);
}

/**
 * Next version for a bump.
 *  - major / minor: one above the highest version ever used.
 *  - patch: one above the highest patch in the line being patched
 *    (patching v2.16.0 gives v2.16.1 even if v2.17.0 exists).
 * `patchOf` is required for patch and must be a used version.
 */
export function nextVersion(bump, used, patchOf) {
  const highest = used.at(-1) ?? { major: 0, minor: 0, patch: 0 };
  switch (bump) {
    case 'major':
      return { major: highest.major + 1, minor: 0, patch: 0 };
    case 'minor':
      return { major: highest.major, minor: highest.minor + 1, patch: 0 };
    case 'patch': {
      if (!patchOf) throw new Error('A patch release needs the release it patches.');
      if (!used.some((v) => compareVersions(v, patchOf) === 0)) {
        throw new Error(`${formatVersion(patchOf)} does not exist, so it can't be patched.`);
      }
      const line = used.filter((v) => v.major === patchOf.major && v.minor === patchOf.minor);
      return { ...patchOf, patch: line.at(-1).patch + 1 };
    }
    default:
      throw new Error(`Unknown bump "${bump}". Use major, minor or patch.`);
  }
}

/** Branches allowed as the source of a PR into a release branch. */
export function checkReleaseSource(sourceBranch, targetVersion) {
  const isPatch = targetVersion.patch > 0;
  if (isPatch) {
    return isHotfixBranch(sourceBranch)
      ? { ok: true }
      : { ok: false, reason: `Patch releases only accept hotfix/HR-<ticket>_<description> branches, not "${sourceBranch}".` };
  }
  return isRcBranch(sourceBranch)
    ? { ok: true }
    : { ok: false, reason: `Major and minor releases only accept rc/<name> branches, not "${sourceBranch}".` };
}
