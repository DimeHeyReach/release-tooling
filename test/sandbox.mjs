// A throwaway "GitHub": a bare origin repo on disk, a dev clone to build
// history in, and a fresh runner clone like actions/checkout with fetch-depth 0.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createGit } from '../src/git.mjs';

export function createSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'release-tooling-'));
  const origin = join(root, 'origin.git');
  const dev = join(root, 'dev');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const identity = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];

  git(root, 'init', '-q', '--bare', '-b', 'master', origin);
  git(root, 'clone', '-q', origin, dev);
  let n = 0;

  const sb = {
    root,
    origin,
    /** Commit a change on the current dev branch. */
    commit(message = `change ${++n}`) {
      writeFileSync(join(dev, `file-${n}-${Date.now()}.txt`), message);
      git(dev, 'add', '-A');
      git(dev, ...identity, 'commit', '-q', '-m', message);
      return sb;
    },
    /** Commit a specific file's content (for making conflicts on purpose). */
    edit(file, content, message = `edit ${file}`) {
      writeFileSync(join(dev, file), content);
      git(dev, 'add', '-A');
      git(dev, ...identity, 'commit', '-q', '-m', message);
      return sb;
    },
    /** Refresh dev's view of origin (after a runner pushed). */
    pull() {
      git(dev, 'fetch', '-q', 'origin');
      return sb;
    },
    checkout(branch, { create = false, from } = {}) {
      git(dev, 'checkout', '-q', ...(create ? ['-b', branch, ...(from ? [from] : [])] : [branch]));
      return sb;
    },
    /** Merge commit, like our PR merges. */
    merge(branch, message = `Merge ${branch}`) {
      git(dev, ...identity, 'merge', '-q', '--no-ff', '-m', message, branch);
      return sb;
    },
    tag(name) {
      git(dev, 'tag', name);
      return sb;
    },
    push(...refs) {
      git(dev, 'push', '-q', 'origin', ...refs);
      return sb;
    },
    deleteRemote(branch) {
      git(dev, 'push', '-q', 'origin', '--delete', branch);
      return sb;
    },
    /** A fresh full clone, as the workflow runner would have. */
    runner() {
      const dir = mkdtempSync(join(root, 'runner-'));
      git(root, 'clone', '-q', origin, dir);
      git(dir, 'fetch', '-q', '--tags', 'origin');
      return createGit(dir);
    },
    originBranches() {
      return git(origin, 'for-each-ref', '--format=%(refname:strip=2)', 'refs/heads/').split('\n').filter(Boolean);
    },
    originSha(ref) {
      return git(origin, 'rev-parse', ref);
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };

  sb.commit('initial').push('master');
  return sb;
}
