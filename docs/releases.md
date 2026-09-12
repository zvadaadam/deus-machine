# Desktop and CLI releases

`.github/workflows/release.yml` builds and verifies the macOS and Linux desktop
installers, stages a draft GitHub Release, publishes the matching `deus-machine`
CLI, then makes the release public. A failed CLI publish leaves the installers
in draft.

## Starting a release

Use **Actions → Release → Run workflow** on `main` and choose a patch, minor or
major bump. The workflow updates both package versions, commits and tags them,
then builds that tag. `dry_run=true` builds the selected source without committing,
tagging or publishing.

Alternatively, update both versions with `bash scripts/bump-version.sh X.Y.Z`,
merge that change to `main`, then push its `vX.Y.Z` tag. The same workflow runs;
the tag must match `package.json` and `apps/cli/package.json` and point to a commit
on `main`. Only stable `vX.Y.Z` releases are supported. Workflow-created tags use
`GITHUB_TOKEN`, so they do not trigger a duplicate run.

If a job fails, rerun failed jobs on the existing release run. Keep its version,
tag and successful artifacts; do not move the tag or bump again to retry a
publishing failure.

## npm trusted publishing

In [the package settings](https://www.npmjs.com/package/deus-machine/access), add
a GitHub Actions trusted publisher:

| Setting           | Value                                    |
| ----------------- | ---------------------------------------- |
| Owner             | `zvadaadam`                              |
| Repository        | `deus-machine`                           |
| Workflow filename | `release.yml`                            |
| Environment       | Leave empty                              |
| Allowed action    | Enable direct publishing (`npm publish`) |

The `publish-cli` job has `id-token: write` and runs on a GitHub-hosted runner.
Bun installs, builds and packs the CLI; the pinned npm publishing client exchanges
the workflow identity for short-lived publishing access. No `NPM_TOKEN` secret or
local publishing token is needed. This follows
[npm's trusted publishing setup](https://docs.npmjs.com/trusted-publishers/).

Apple signing and notarization still use the Apple secrets documented at the top
of the workflow. npm authentication applies to the CLI package, while GitHub
hosts the desktop installers and update feeds.

## macOS artifacts

The updater uses architecture-specific ZIPs and their metadata/blockmaps. DMGs
are manual installers and have update metadata disabled: Apple's later stapling
step changes their bytes. Both Apple Silicon (`*-arm64.dmg`) and Intel
(`Deus-X.Y.Z.dmg`) remain downloadable and supported by `deus install`.
