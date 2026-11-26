# What Microtica must do

All release logic lives in GitHub. Microtica does two things, **in production pipelines only**. Staging, dev and any other environment must not do either.

A working reference is `templates/simulate-deploy.yml`: the demo repo's "Simulate deploy" button does exactly this.

## Access

A GitHub token that can, on each product repo:

- read commit statuses (M1), and
- create a repository dispatch event (M2): **Contents: write**.

The cleanest option is a GitHub App installation token (the release bot, or a separate "microtica" App). A fine-grained personal access token also works.

Store it as a secret in Microtica; below it's `$GITHUB_TOKEN`. `$REPO` is `owner/name`, `$VERSION` is e.g. `2.16.0`.

## M1: before a production deploy, check `release-ready`

Find the commit being deployed (the release branch's latest commit), then read its newest `release-ready` status. Deploy **only** if it is `success`.

```bash
SHA=$(curl -fsS -H "Authorization: Bearer $GITHUB_TOKEN" \
  "https://api.github.com/repos/$REPO/commits/release/v$VERSION" | jq -r .sha)

STATE=$(curl -fsS -H "Authorization: Bearer $GITHUB_TOKEN" \
  "https://api.github.com/repos/$REPO/commits/$SHA/statuses" \
  | jq -r '[.[] | select(.context == "release-ready")][0].state')

[ "$STATE" = "success" ] || { echo "Not release-ready, deploy aborted"; exit 1; }
```

Statuses are returned newest first, so the first `release-ready` entry is the current one. No entry at all also means "not ready".

## M2: after a successful production deploy, report it

```bash
curl -fsS -X POST -H "Authorization: Bearer $GITHUB_TOKEN" \
  "https://api.github.com/repos/$REPO/dispatches" \
  -d "{\"event_type\":\"deployed\",\"client_payload\":{\"version\":\"$VERSION\",\"sha\":\"$SHA\",\"environment\":\"production\"}}"
```

| Field | Value |
|---|---|
| `event_type` | Always `deployed` |
| `client_payload.version` | The version deployed, e.g. `2.16.0` (a leading `v` is fine) |
| `client_payload.sha` | The **full** 40-character commit that went live |
| `client_payload.environment` | `production` (anything else is ignored by GitHub) |

GitHub answers `204 No Content`. It then moves the `deployed` label, tags `vX.Y.Z` on the first deploy, and unlocks merging.

## Rollbacks

Redeploying an older version is a normal production deploy: send M2 for the version and commit that are now live. M1 may refuse an old release (for example once `master` has moved on); for a rollback, Microtica may skip M1.

## Failures

Only send M2 after a **successful** deploy. Nothing needs to be sent for a failed one.
