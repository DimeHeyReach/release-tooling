// "Release source check": which branches may open a PR into which.
//  - into master:          only release/vX.Y.Z
//  - into a major/minor:   only rc/<name> (one RC per release only if singleRc is on;
//                          off by default, to be revisited)
//  - into a patch release: only hotfix/HR-<ticket>_<description>
import { parseReleaseBranch, checkReleaseSource, isRcBranch } from './versions.mjs';
import { isToolingUpdate } from './tooling-update.mjs';

/**
 * Pure decision. `mergedIntoBase` is the list of PRs already merged into the
 * target branch ({ number, head }); the current PR is ignored if present.
 */
export function evaluateSourceCheck({ base, head, number, mainBranch = 'master', mergedIntoBase = [], singleRc = false, author, botLogin }) {
  if (base === mainBranch) {
    if (isToolingUpdate({ head, author, botLogin })) {
      return { ok: true, message: `Workflow update opened by ${botLogin}; may merge into ${mainBranch} once approved.` };
    }
    return parseReleaseBranch(head)
      ? { ok: true, message: `\`${head}\` may merge into ${mainBranch}.` }
      : { ok: false, message: `Only release/vX.Y.Z branches may merge into ${mainBranch}, not "${head}".` };
  }

  const version = parseReleaseBranch(base);
  if (!version) {
    return { ok: false, message: `"${base}" is not a valid release branch name (release/vX.Y.Z).` };
  }

  const source = checkReleaseSource(head, version);
  if (!source.ok) return { ok: false, message: source.reason };

  if (singleRc && version.patch === 0) {
    const earlier = mergedIntoBase.find((p) => p.number !== number && isRcBranch(p.head));
    if (earlier) {
      return {
        ok: false,
        message: `\`${base}\` already has an RC (\`${earlier.head}\`, #${earlier.number}). One RC per release: create a new release for this one.`,
      };
    }
  }
  return { ok: true, message: `\`${head}\` may merge into \`${base}\`.` };
}

/** Runs the check for a pull_request event. */
export async function runSourceCheck(github, { base, head, number, mainBranch, singleRc = false, author, botLogin }) {
  const needsHistory = singleRc && base !== mainBranch && parseReleaseBranch(base)?.patch === 0;
  const mergedIntoBase = needsHistory ? await github.mergedPullsInto(base) : [];
  return evaluateSourceCheck({ base, head, number, mainBranch, mergedIntoBase, singleRc, author, botLogin });
}
