// Thin wrapper around the git CLI. Reads the remote-tracking refs of a full
// clone (actions/checkout with fetch-depth: 0), so it sees every branch and tag.
import { execFileSync } from 'node:child_process';

export function createGit(cwd = process.cwd()) {
  const run = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  const tryRun = (...args) => {
    try {
      run(...args);
      return true;
    } catch {
      return false;
    }
  };

  return {
    run,

    /** Branch names on origin, without the "origin/" prefix. */
    remoteBranches() {
      return run('for-each-ref', '--format=%(refname:strip=3)', 'refs/remotes/origin/')
        .split('\n')
        .filter((b) => b && b !== 'HEAD');
    },

    tags() {
      return run('for-each-ref', '--format=%(refname:strip=2)', 'refs/tags/').split('\n').filter(Boolean);
    },

    /** Commit a branch on origin or a tag points at. */
    sha(ref) {
      return run('rev-parse', '--verify', `${ref}^{commit}`);
    },

    /** True if `ancestor` is already contained in `descendant`. */
    isAncestor(ancestor, descendant) {
      return tryRun('merge-base', '--is-ancestor', ancestor, descendant);
    },

    /**
     * Create a branch on origin pointing at a commit. Fails if it already
     * exists (an empty lease means "only if the ref doesn't exist"), so two
     * runs at the same time can never move each other's branch.
     */
    pushNewBranch(sha, branch) {
      const ref = `refs/heads/${branch}`;
      run('push', `--force-with-lease=${ref}:`, 'origin', `${sha}:${ref}`);
    },

    /** Create a tag on origin. Fails if the tag already exists. */
    pushNewTag(sha, tag) {
      const ref = `refs/tags/${tag}`;
      run('push', '-q', `--force-with-lease=${ref}:`, 'origin', `${sha}:${ref}`);
      run('fetch', '-q', 'origin', `+${ref}:${ref}`);
    },

    /** Delete a branch on origin, but only if it still points at `expectedSha`. */
    deleteBranch(branch, expectedSha) {
      const ref = `refs/heads/${branch}`;
      run('push', '-q', `--force-with-lease=${ref}:${expectedSha}`, 'origin', `:${ref}`);
      run('update-ref', '-d', `refs/remotes/origin/${branch}`);
    },

    /** When `sha` first reached `branch`: commit date of the earliest merge on the path, or null. */
    mergedAt(sha, branch) {
      const first = run('rev-list', '--ancestry-path', '--merges', '--reverse', `${sha}..origin/${branch}`).split('\n')[0];
      return first ? new Date(run('show', '-s', '--format=%cI', first)) : null;
    },

    /**
     * Merge commits made directly on a branch (first-parent history only, so
     * "merge master into release" commits that later reached it are skipped),
     * newest first: [{ sha, subject, secondParent }].
     */
    merges(branch) {
      const out = run('log', `origin/${branch}`, '--first-parent', '--merges', '--format=%H%x09%P%x09%s');
      return out.split('\n').filter(Boolean).map((line) => {
        const [sha, parents, subject] = line.split('\t');
        return { sha, subject, secondParent: parents.split(' ')[1] };
      });
    },

    /**
     * Merge origin/<from> into origin/<into> with a merge commit and push it.
     * Returns { status: 'up-to-date' | 'merged' | 'conflict', files }.
     * On conflict nothing is pushed and the working tree is left clean.
     * The push is a normal fast-forward push: if someone pushed to the
     * branch in the meantime it fails instead of overwriting their work.
     */
    mergeAndPush(from, into, identity) {
      if (this.isAncestor(`origin/${from}`, `origin/${into}`)) return { status: 'up-to-date', files: [] };
      run('checkout', '-q', '-B', into, `origin/${into}`);
      const id = ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`];
      if (!tryRun(...id, 'merge', '--no-ff', '-q', '-m', `Merge ${from} into ${into}`, `origin/${from}`)) {
        const files = run('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
        run('merge', '--abort');
        return { status: 'conflict', files };
      }
      run('push', '-q', 'origin', `HEAD:refs/heads/${into}`);
      run('fetch', '-q', 'origin', `+refs/heads/${into}:refs/remotes/origin/${into}`);
      return { status: 'merged', files: [] };
    },
  };
}
