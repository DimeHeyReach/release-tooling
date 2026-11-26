# Demo walkthrough

A full run of the release process on `release-process-demo`, in about 20 minutes. Each step says what to click and what everyone should see.

**Before the demo:** the demo repo is in **enforce** mode (release-tooling → Actions → Manage repo → `release-process-demo`, mode enforce, demo ticked) and its install PR is merged. Keep two tabs open: the demo repo's **Actions** and **Pull requests**.

## 1. Cut a release

**Actions → Create release → Run workflow**: bump **minor**.

> ✅ Created `release/v0.1.0`, cut from master.

Point out: nobody typed a version number.

## 2. Try to cut a branch by hand (enforce mode)

```bash
git push origin master:release/v9.9.9
```

> Rejected by the ruleset: only the release bot can create release branches.

## 3. Build and test a release candidate

```bash
git checkout -b rc/demo-feature master && echo "feature" > feature.txt && git add . && git commit -m "Demo feature" && git push -u origin rc/demo-feature
```

Open a PR **`rc/demo-feature` → `release/v0.1.0`**. *Release source check* is green.

Point out: a PR from a `feature/...` branch into the release would be red.

## 4. Merge the RC

Merge the PR. Within a minute, in **Release automation**:

> Deleted `rc/demo-feature` · Opened release PR · master: already up to date · Auto-merge enabled

A **"Release v0.1.0"** PR to `master` appears. Its *Release merge gate* is red: *not live in production*. Approve it now; it still can't merge.

## 5. Show that a higher release must wait

Create release → **minor** again:

> ⛔ Not created: `release/v0.2.0`. These releases are not merged into master yet: `release/v0.1.0`

Run it again with **Proceed with unmerged releases** ticked: `release/v0.2.0` is created, with the warning repeated. Look at the `release-ready` status on `release/v0.2.0`'s latest commit (branch page → commit → status icon):

> ⛔ Not ready: not merged or scrapped yet: v0.1.0

**Simulate deploy** → version `0.2.0`, production:

> ⛔ Deploy refused: Not ready: not merged or scrapped yet: v0.1.0

## 6. Deploy to staging, then production

**Simulate deploy** → `0.1.0`, **staging**: deployed, *no event sent*. Nothing changes on the PR.

**Simulate deploy** → `0.1.0`, **production**:

> 🚀 v0.1.0 is live in production · Tag `v0.1.0` created · `deployed` label is now on the release PR

The merge gate turns green and, because it was approved, **the PR merges itself**.

## 7. Watch master flow into the next release

After the merge, Release automation pulls `master` into `release/v0.2.0` and its `release-ready` turns ✅.

## 8. Production behind the branch

Deploy `0.2.0` to production. Then merge a second RC into the live release:

```bash
git checkout -b rc/late-fix master && echo "late" > late.txt && git add . && git commit -m "Late fix" && git push -u origin rc/late-fix
```

PR `rc/late-fix` → `release/v0.2.0`, merge it. The branch is now ahead of what's live:

> ℹ️ Production is behind `release/v0.2.0` (label + comment with a compare link)

Deploy `0.2.0` again: the flag clears.

## 9. Scrap a release

Create release → minor (`v0.3.0`), then **Scrap release** → `v0.3.0`.

> 🗑️ Scrapped v0.3.0 · marker `scrapped/v0.3.0` · branch deleted

Create release → minor again: you get **`v0.4.0`**. The scrapped number is never reused.

## 10. Hotfix

Create release → **patch**, patch of `v0.2.0` → `release/v0.2.1`, cut from the release, not master. A `hotfix/HR-123_demo` PR into it is green; an `rc/...` PR is red.

## 11. Off switch

Manage repo → `release-process-demo`, mode **off**. Push anything: every release workflow shows as skipped, and the rulesets are gone.
