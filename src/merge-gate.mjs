// "Release merge gate": a release PR into master may only merge while the
// release is the one live in production (it has the deployed label).
import { parseReleaseBranch } from './versions.mjs';
import { DEPLOYED_LABEL } from './deployed.mjs';

export function evaluateMergeGate({ base, head, labels, mainBranch = 'master' }) {
  if (base !== mainBranch) return { ok: true, message: `Not a PR into ${mainBranch}; nothing to check.` };
  if (!parseReleaseBranch(head)) {
    return { ok: false, message: `Only release branches may merge into ${mainBranch}.` };
  }
  return labels.includes(DEPLOYED_LABEL)
    ? { ok: true, message: `\`${head}\` is live in production and may merge once approved.` }
    : { ok: false, message: `\`${head}\` is not live in production. It can merge only while it has the \`${DEPLOYED_LABEL}\` label.` };
}
