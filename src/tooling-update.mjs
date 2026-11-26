// The one non-release PR allowed into master: the workflow-file update that
// Manage repo opens. Recognised by its branch AND by being opened by the
// release bot itself, so naming a branch the same way isn't enough.
export const INSTALL_BRANCH = 'release-tooling/install';

export function isToolingUpdate({ head, author, botLogin }) {
  return head === INSTALL_BRANCH && Boolean(botLogin) && author === botLogin;
}
