# release-tooling

Release automation shared by all product repos. The process it enforces is described in the Notion page **"Release process automation"**: `master` holds only released code, work is tested on `rc/*` branches, and `release/vX.Y.Z` branches carry exactly what goes to production.

All logic lives here. A product repo gets a handful of small workflow files (installed by the **Manage repo** button) that call the shared workflows in this repo.

## What a product repo gets

| Workflow | Started by | Does |
|---|---|---|
| **Create release** | Button: major / minor / patch | Works out the version, warns about unmerged releases, cuts `release/vX.Y.Z` |
| **Release checks** | Every PR into `master` or `release/*` | *Release source check*: only `rc/*` (or `hotfix/HR-*` for patches) into releases, only `release/*` into master. *Release merge gate*: a release merges only while it's live |
| **Release automation** | Merges into releases, pushes to `master` and `release/*` | Deletes the RC, pulls `master` into releases, opens the release → `master` PR with auto-merge, flags conflicts, updates `release-ready`, flags when production is behind |
| **Release deployed** | Microtica's `deployed` event | Moves the `deployed` label, tags `vX.Y.Z` on first deploy |
| **Scrap release** | Button: version | Burns the number (`scrapped/vX.Y.Z`), closes the PR, deletes the branch |
| **Clean up releases** | Nightly (and a dry-run button) | Deletes release branches merged more than 90 days ago. Tags stay |
| **Simulate deploy** | Button (demo repos only) | Stands in for Microtica |

Buttons that live here in release-tooling:

| Workflow | Does |
|---|---|
| **Manage repo** | Turns a repo `off`, `warn` (reports only) or `enforce` (blocks merges) |
| **Migrate a repo** | One-time: tags past releases from `master`'s history and decides on old unmerged branches. Dry run by default |

## Modes

Each product repo has a variable `RELEASE_TOOLING_MODE`:

| Mode | Effect |
|---|---|
| `off` / not set | Every release workflow skips itself |
| `warn` | Everything runs and reports; nothing blocks merges |
| `enforce` | Plus branch rulesets: only the bot creates release branches, checks are required, `master` needs an approval |

A second variable, `RELEASE_TOOLING_SINGLE_RC` (`true`/`false`, default off), allows only one `rc/*` branch per major/minor release. Set it with the **One RC per release** option on Manage repo (`keep` leaves it unchanged).

## Labels and statuses

| Name | Kind | Meaning |
|---|---|---|
| `deployed` | Label on the release PR | This release is live in production now. Moves on every deploy |
| `release:conflict` | Label | `master` couldn't be merged into the release automatically |
| `release:behind-production` | Label | The branch has commits newer than what's deployed |
| `release-ready` | Commit status | Safe to deploy: contains `master`, and every lower release is merged, scrapped or included |
| `source / Release source check` | Check | Required on `master` and `release/*` in enforce mode |
| `source / Release merge gate` | Check | Required on `master` in enforce mode |

## Docs

- [Setup](docs/SETUP.md): creating the bot, turning a repo on.
- [Microtica](docs/MICROTICA.md): what the deploy pipeline must do.
- [Demo](docs/DEMO.md): a step-by-step walkthrough on the demo repo.

## Development

```bash
npm test
```

Node 20+, no dependencies. Git behaviour is tested against throwaway repos on disk; GitHub is faked in memory.

| Path | What |
|---|---|
| `src/versions.mjs` | Version numbers and branch-name rules |
| `src/git.mjs`, `src/github.mjs` | Thin git CLI and GitHub API wrappers |
| `src/create-release.mjs` | Create release |
| `src/source-check.mjs`, `src/merge-gate.mjs` | PR checks |
| `src/sync.mjs`, `src/release-pr.mjs` | RC merged, master sync, release PR and its labels |
| `src/readiness.mjs` | `release-ready` |
| `src/deployed.mjs`, `src/behind.mjs` | Deployed event, behind-production flag |
| `src/scrap.mjs`, `src/cleanup.mjs`, `src/migrate.mjs` | Scrap, cleanup, migration |
| `src/manage.mjs` | Manage repo (modes, install PR, rulesets) |
| `src/cli.mjs` | Entry point the workflows run: `node src/cli.mjs <command>` |
| `templates/` | Workflow files installed into product repos |

Releases of this repo are tags (`v1`, …). Product repos pin `@v1`; move the `v1` tag to ship a fix to all of them.
