# Project environment SDK preview

These API/SDK packages are packed from AGNT commit
[`a5f088298992919c85e61055f93517866459a507`](https://github.com/zvadaadam/AGNT/commit/a5f088298992919c85e61055f93517866459a507)
after its normal build, with version `2.1.0-environment.a5f08829` and `gitHead` stamped in each
manifest. The SDK depends on that same API version; the root override resolves it
to the checked-in archive. There are no links to another developer's worktree.

This lets this PR install and run before the upstream Changesets release. Before
releasing Deus, publish the AGNT API/SDK changes, replace both root dependencies
with the published version, remove the API override and this directory, and run
`bun install` plus the normal checks.

To rebuild a preview, build the pinned AGNT commit, copy its `packages/api` and
`packages/sdk` package manifests and built `dist` directories into a disposable
directory, stamp the version and `gitHead`, replace the SDK's `workspace:*` API
dependency with the matching version, then `bun pm pack --ignore-scripts`. Use
a new filename for a new commit: Bun caches local tarballs by path.
