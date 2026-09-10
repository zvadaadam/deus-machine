# Project environments

Settings → Environments lists repositories. Open one to edit Setup, Run, public
variables and required variable names. Setup and Run are shared between local and
cloud; expand **Customize for local or cloud** when the commands differ.
Horizontal Local / Cloud tabs below the repository name and GitHub link choose
where **Set up with agent** creates its validation workspace. They do not create
separate copies of the shared recipe.

Deus selects one complete recipe:

1. `.deus/environment.json` in the actual checkout.
2. Saved project settings in AGNT when the file is absent.
3. No custom setup when neither exists.

An invalid file or a failed lookup is an error, never permission to run different
saved commands. The file's `version` identifies its schema, not its priority.
Deleting the file returns that checkout to the saved defaults. File contents are
never automatically copied into saved settings.

```json
{
  "version": 1,
  "setup": "bun install --frozen-lockfile",
  "run": "bun run dev",
  "env": { "PORT": "3000" },
  "requiredEnv": ["DATABASE_URL"],
  "tasks": { "test": "bun test" },
  "local": { "run": "bun run desktop" },
  "cloud": { "run": "bun run dev --host 0.0.0.0" }
}
```

Inside each target, an omitted command inherits the shared command and `null`
disables it. Target public variables override common values; required names are
combined. Additional commands are simple name/command pairs in the Run menu.
The name `run` is reserved for the main Run command. The local Run menu includes
that command; cloud menus offer only additional commands because AGNT already
supervises the app process.

## Saving and sharing

Without a file, Save setup writes the public recipe to the existing AGNT environment
record. Its identity, machine configuration and secret associations stay intact.
With a file, the form saves that file in the local checkout and identifies the branch.
Use normal Git commit/push to publish it. Save to repository exports only the public
recipe and makes that file visible to Git while keeping other `.deus` data ignored.
The root `deus.json` format and automatic package-manager detection are removed.

For GitHub-only repositories, settings reads the default branch with the Deus App's
existing access. A remote file is read-only here. Add the repository to Deus and use
a setup workspace to edit and publish it. Explicit SDK environments remain managed
through the SDK; the simplified form cannot silently replace their configuration.

## Workspace controls

An empty, idle chat offers **Set up this project** only when the workspace lookup
has confirmed that no recipe is configured. Loading and failed lookups do not
trigger a setup suggestion. The prompt disappears after conversation starts.

The header runs configured commands and opens environment settings directly for
that workspace's repository. With no commands, only the settings button remains.
**Run app** starts the local Run script in a terminal; other entries run the named
additional commands. Cloud omits Run app because its main process starts during
preparation. A **Computer ready** entry records cloud provisioning, not an app
health check or proof that a custom project setup has been saved.

## Execution

Local preparation creates the worktree, copies `.env` and `.env.local` without
replacing existing files, then reads the checkout's recipe. Setup runs in the
repository with `/bin/sh -ec`: commands share shell state and a failing command
stops the script. A failure exposes the setup log and leaves the workspace available
for repair. An interactive terminal stays available even if the recipe is invalid.
There is no implicit dependency installation or reset of tracked setup changes.
Local Run starts the selected command explicitly and reads the current recipe.

Cloud preparation clones and restores Git work before reading the file. It then
resolves the cloud overrides, merges authorized secrets over public defaults,
checks required names, and starts the sidecar, Setup and the foreground Run command.
AGNT supervises Run in the background. The workspace records the public recipe
actually applied. Pause/resume retains the process; VM recreation prepares it again
from its saved workspace configuration and recovered checkout.

Saving configuration or secrets never restarts existing processes. Cloud changes
apply to new workspaces; local Run is an explicit new command. Local values come
from the computer's environment and local dotenv files, not downloaded cloud secrets.
See [application secrets](application-secrets.md) for scopes and permissions.

## Ownership and validation

`@deus-hq/api` owns the schema and target resolver. Deus owns the form and local
execution. AGNT owns cloud checkout and preparation. Agent Server is unchanged.
SDK repository discovery is opt-in with `Environment.project()`; explicit
`setup()`/`run()` configurations retain their contract.

In settings, `EnvironmentSection` owns organization and repository navigation.
`RepositoryEnvironmentSettings` selects the file or saved recipe and writes it;
`ProjectEnvironmentEditor` owns draft input and validation. Secret management is
independent of that draft, so adding a secret does not discard unsaved scripts.

The automated qualification covers real local Git worktrees and shell execution,
authenticated settings/secret routes with isolated Postgres, both browser transports,
the full local app Settings → Git checkout → Setup → Run terminal journey,
and real E2B checkout → Setup → sidecar → Run HTTP app → pause/resume → cleanup.
The VM test uses a disposable Git origin and synthetic application credentials.
It does not deploy production or exercise the complete Durable Object lifecycle.

Roll out AGNT's migration, backend and sidecar, then its API/SDK package release,
before releasing Deus. Migration 0013 converts previous repository settings once,
retaining their cloud-only meaning; explicit SDK configurations are left alone.
A custom pre-clone/parallel repository recipe must be intentionally converted before
that migration rather than silently losing its execution semantics.

The Deus review branch pins API/SDK preview archives from the upstream commit
(see [vendor/README.md](../vendor/README.md)) so a fresh checkout can run the new
contract. Replace those pins with the normal published package versions before
releasing Deus.
