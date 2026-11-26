#!/usr/bin/env node
// Entry point for the shared workflows: `node src/cli.mjs <command>`.
// Inputs come from environment variables set by the workflow.
import { appendFileSync } from 'node:fs';
import { createGit } from './git.mjs';
import { createRelease, summarize } from './create-release.mjs';
import { createGitHub } from './github.mjs';
import { runSourceCheck } from './source-check.mjs';
import { onReleaseMerge, syncAllReleases, summarizeReleaseMerge, summarizeSync } from './sync.mjs';
import { updateAllReadiness, summarizeReadiness } from './readiness.mjs';
import { handleDeployed, summarizeDeployed } from './deployed.mjs';
import { evaluateMergeGate } from './merge-gate.mjs';
import { syncAllBehindFlags } from './behind.mjs';
import { scrapRelease, summarizeScrap } from './scrap.mjs';
import { runCleanup, summarizeCleanup } from './cleanup.mjs';
import { planMigration, applyMigration, summarizeMigration } from './migrate.mjs';
import { manageRepo, summarizeManage } from './manage.mjs';
import { fileURLToPath } from 'node:url';

const identity = () => ({ name: env.BOT_NAME, email: env.BOT_EMAIL });
const github = () => createGitHub({ token: env.GH_TOKEN, repository: env.GITHUB_REPOSITORY });

const env = process.env;

function writeSummary(markdown) {
  console.log(markdown);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

function setOutput(name, value) {
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

const commands = {
  'create-release'() {
    const result = createRelease(createGit(env.REPO_DIR), {
      bump: env.BUMP,
      patchOf: env.PATCH_OF || undefined,
      mainBranch: env.MAIN_BRANCH || 'master',
      proceedWithUnmerged: env.PROCEED_WITH_UNMERGED === 'true',
    });
    writeSummary(summarize(result));
    setOutput('branch', result.plan.branch);
    setOutput('version', result.plan.version);
    return result.created ? 0 : 1;
  },

  async 'source-check'() {
    const github = createGitHub({ token: env.GH_TOKEN, repository: env.GITHUB_REPOSITORY });
    const result = await runSourceCheck(github, {
      base: env.BASE_REF,
      head: env.HEAD_REF,
      number: Number(env.PR_NUMBER),
      mainBranch: env.MAIN_BRANCH || 'master',
      singleRc: env.SINGLE_RC === 'true',
      author: env.PR_AUTHOR,
      botLogin: env.BOT_LOGIN,
    });
    writeSummary(`## ${result.ok ? '✅' : '⛔'} ${result.message}`);
    return result.ok ? 0 : 1;
  },

  async 'on-release-merge'() {
    const result = await onReleaseMerge({
      git: createGit(env.REPO_DIR),
      github: github(),
      repository: env.GITHUB_REPOSITORY,
      base: env.BASE_REF,
      head: env.HEAD_REF,
      merged: env.MERGED === 'true',
      mainBranch: env.MAIN_BRANCH || 'master',
      identity: identity(),
      autoMerge: env.MODE === 'enforce',
    });
    writeSummary(summarizeReleaseMerge(result));
    return 0; // conflicts and missing auto-merge are reported on the PR, not as a failed run
  },

  async 'sync-releases'() {
    const results = await syncAllReleases({
      git: createGit(env.REPO_DIR),
      github: github(),
      repository: env.GITHUB_REPOSITORY,
      mainBranch: env.MAIN_BRANCH || 'master',
      identity: identity(),
    });
    writeSummary(summarizeSync(results));
    return results.some((r) => r.status === 'error') ? 1 : 0;
  },

  async readiness() {
    const git = createGit(env.REPO_DIR);
    git.run('fetch', '-q', 'origin'); // pick up anything the earlier steps pushed
    const results = await updateAllReadiness({
      git, github: github(), repository: env.GITHUB_REPOSITORY, mainBranch: env.MAIN_BRANCH || 'master',
    });
    writeSummary(summarizeReadiness(results));
    const behind = (await syncAllBehindFlags(github(), { repository: env.GITHUB_REPOSITORY })).filter((r) => r.behind);
    if (behind.length) {
      writeSummary(`\nℹ️ Production is behind its release branch on PR ${behind.map((r) => `#${r.number}`).join(', ')}.`);
    }
    return 0;
  },

  async deployed() {
    const result = await handleDeployed({
      github: github(),
      repository: env.GITHUB_REPOSITORY,
      payload: JSON.parse(env.PAYLOAD || '{}'),
      mainBranch: env.MAIN_BRANCH || 'master',
    });
    writeSummary(summarizeDeployed(result));
    return 0;
  },

  async scrap() {
    const result = await scrapRelease({
      git: createGit(env.REPO_DIR),
      github: github(),
      repository: env.GITHUB_REPOSITORY,
      version: env.VERSION,
      mainBranch: env.MAIN_BRANCH || 'master',
      actor: env.GITHUB_ACTOR,
    });
    writeSummary(summarizeScrap(result));
    return 0;
  },

  cleanup() {
    const dryRun = env.DRY_RUN === 'true';
    const days = Number(env.DAYS || 90);
    const plan = runCleanup({ git: createGit(env.REPO_DIR), dryRun, days, mainBranch: env.MAIN_BRANCH || 'master' });
    writeSummary(summarizeCleanup(plan, { dryRun, days }));
    return 0;
  },

  migrate() {
    const dryRun = env.DRY_RUN !== 'false'; // dry run unless explicitly turned off
    const scrap = (env.SCRAP || '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => (s.startsWith('v') ? s : `v${s}`));
    const git = createGit(env.REPO_DIR);
    const plan = planMigration({ git, mainBranch: env.MAIN_BRANCH || 'master', scrap });
    if (!dryRun) applyMigration({ git, plan });
    writeSummary(summarizeMigration(plan, { dryRun }));
    return 0;
  },

  async manage() {
    const result = await manageRepo({
      github: createGitHub({ token: env.GH_TOKEN, repository: env.TARGET_REPO }),
      repo: env.TARGET_REPO,
      mode: env.MODE,
      demo: env.DEMO === 'true',
      singleRc: env.SINGLE_RC || 'keep',
      appId: env.APP_ID,
      mainBranch: env.MAIN_BRANCH || 'master',
      templatesDir: fileURLToPath(new URL('../templates', import.meta.url)),
    });
    writeSummary(summarizeManage(result));
    return 0;
  },

  'merge-gate'() {
    const result = evaluateMergeGate({
      base: env.BASE_REF,
      head: env.HEAD_REF,
      labels: JSON.parse(env.LABELS || '[]'),
      mainBranch: env.MAIN_BRANCH || 'master',
      author: env.PR_AUTHOR,
      botLogin: env.BOT_LOGIN,
    });
    writeSummary(`## ${result.ok ? '✅' : '⛔'} ${result.message}`);
    return result.ok ? 0 : 1;
  },
};

const name = process.argv[2];
if (!commands[name]) {
  console.error(`Unknown command "${name}". Known: ${Object.keys(commands).join(', ')}`);
  process.exit(2);
}
try {
  process.exit(await commands[name]());
} catch (err) {
  writeSummary(`## ❌ ${err.message}`);
  process.exit(1);
}
