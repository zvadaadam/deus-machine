# Project environment SDK preview

These API/SDK packages are packed from AGNT commit
[`4a0cc369262f5519016cbbb0771fdb172ba6373b`](https://github.com/zvadaadam/AGNT/commit/4a0cc369262f5519016cbbb0771fdb172ba6373b)
after its normal build, with version `2.1.0-environment.4a0cc369` and `gitHead` stamped in each
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
