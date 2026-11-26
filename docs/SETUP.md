# Setup

Everything below is done once per owner (a personal account or the HeyReach org), except step 5, which is per repo. `<owner>` is that account or org.

## 1. Create the release bot (GitHub App)

Personal account: **Settings → Developer settings → GitHub Apps → New GitHub App**.
Org: **Org settings → Developer settings → GitHub Apps → New GitHub App** (needs an org owner).

- **Name:** e.g. `<owner>-release-bot` (must be unique on GitHub).
- **Homepage URL:** any, e.g. the release-tooling repo URL.
- **Webhook:** untick **Active**.
- **Repository permissions:**

  | Permission | Access | Why |
  |---|---|---|
  | Administration | Read and write | Rulesets and repo settings (Manage repo) |
  | Commit statuses | Read and write | `release-ready` |
  | Contents | Read and write | Branches, tags, merges, dispatch events |
  | Issues | Read and write | Labels and comments |
  | Pull requests | Read and write | Release PRs, auto-merge |
  | Variables | Read and write | `RELEASE_TOOLING_MODE` |
  | Workflows | Read and write | Installing workflow files |
  | Metadata | Read-only | Required |

- **Organization permissions** (org only): Members → Read-only, for the `allowed_team` check.
- **Where can this app be installed:** Only on this account.

Create it, then:

1. Note the **App ID** on the app's page.
2. **Generate a private key** (bottom of the page). A `.pem` file downloads.
3. **Install App** → choose **Only select repositories** → `release-tooling` plus every repo that will use it.

## 2. Add the bot's secrets

Add `RELEASE_BOT_APP_ID` and `RELEASE_BOT_PRIVATE_KEY` to `release-tooling` and to every product repo. In an org, add them once as **org secrets** instead.

```bash
gh secret set RELEASE_BOT_APP_ID --repo <owner>/<repo> --body <app id>
```

```bash
gh secret set RELEASE_BOT_PRIVATE_KEY --repo <owner>/<repo> < path/to/private-key.pem
```

Delete the `.pem` file from your machine afterwards; GitHub keeps the secret.

## 3. Let product repos use release-tooling's workflows

release-tooling → **Settings → Actions → General → Access**: "Accessible from repositories owned by the user" (personal) or "… in the organization" (org).

## 4. Tag a version of release-tooling

Product repos call `@v1`.

```bash
git tag -f v1 && git push -f origin v1
```

To ship a fix to every repo later, move `v1` to the new commit the same way.

## 5. Turn a repo on

1. **Migrate first** (existing repos only): release-tooling → **Actions → Migrate a repo** → the repo name, dry run ticked. Review the summary, then run it again with dry run off. Put old unmerged release branches you don't want in **Scrap**.
2. release-tooling → **Actions → Manage repo** → the repo name, mode **warn**.
3. Merge the **"Install release-tooling workflows"** PR it opens in that repo.
4. Run in warn mode for a couple of releases. Switch to **enforce** with the same button once the checks look right.

To turn a repo off: **Manage repo** → mode **off**.

## Moving from the personal test setup to the HeyReach org

1. Create the release-tooling repo in the org and push this code.
2. Repeat steps 1–4 for the org (an org owner creates the App).
3. Workflow files reference `<owner>/release-tooling`; Manage repo fills in the owner automatically.
