# Application secrets

Environment settings manages private values used by apps running in cloud
workspaces, including `ELEVENLABS_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and
`E2B_API_KEY`. A project's E2B key is separate from AGNT's Worker-bound provisioning
key. AI Providers remains the place to connect the agent's subscription or inference
account. Names consumed by repository auth (`github_token`, `GITHUB_TOKEN`, `GH_TOKEN`)
or agent login (`CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_AUTH_JSON`) remain reserved by the
runtime's existing auth contracts.

## Repository settings

Environment opens a searchable list of local repositories, repositories accessible
through the Deus GitHub App, and saved cloud recipes. GitHub owner avatars use a
folder fallback. Multiple local clones and additional recipes remain distinguishable.
An unconfirmed GitHub lookup is not presented as missing access.

Open a repository to edit its Cloud or Local setup; breadcrumbs return to the list.
Cloud setup edits the existing recipe's commands while preserving phases, parallel
steps and unrelated configuration. Setup/run scripts and public environment variables
are visible together in Local; archive scripts, tasks and requirements remain under
Advanced setup. Cloud application secrets sit directly below the setup commands.
Tab, repository and organization navigation warn before discarding unsaved scripts.
GitHub App access is required for private repositories, not for saving a recipe.

The repository header has one **Set up with agent** action. It uses the selected
Local/Cloud tab and the model last chosen in the workspace composer. The action
uses the normal workspace creation and first-message path; Cloud checks the selected
provider's connected default account. Starting a setup workspace currently requires
a repository added to Deus on the desktop. GitHub-only rows can save cloud setup and
secrets, but do not yet have a workspace creation path here.

The setup instructions share one workflow across settings, the workspace header and
the composer: inspect existing configuration, separate installation from app startup,
verify setup and app readiness, and report missing secret names. Cloud saves verified
commands through `agnt_configure_environment` for future sandboxes. Local edits the
workspace's versioned `deus.json`; those changes must reach the branch used for future
workspaces. Setup commands requiring shared shell state belong in a script file.

Secrets added on a repository page apply to that recipe automatically. Default
secrets have their own page and cannot be edited accidentally from a repository.
Cloud secrets are not injected into local processes by this feature.

## Behavior

- A signed-in member can save personal values. Organization owners and admins can
  also manage shared values.
- Each value applies to all environments or a selected recipe. Effective precedence
  is personal environment → shared environment → personal default → shared default.
- Settings returns names, ownership, scope and required-value status. Saved values
  are never returned. Replacement requires a new value; deletion can reveal a lower
  priority value with the same name.
- Required values are counted as set when the selected recipe has an effective secret
  or a nonempty public configuration value. This does not validate the key with its
  provider or prove that an app builds successfully.
- Public repository variables remain in committed `deus.json`. Application secrets
  use AGNT's existing encrypted store and are not copied into that file.
- New workspace creation receives the verified account ID and resolved recipe ID.
  A cloud account change during preparation stops creation. Refresh uses the
  workspace's original owner and recipe to resolve values again.
- Saving or deleting a value does not mutate or restart a running VM. Existing
  processes retain the environment they started with; create a new cloud workspace
  to use a changed application value immediately.

## Boundaries

The desktop backend forwards fixed dashboard paths using its human session. Direct
web uses the signed-in browser session. The platform checks current membership and
derives personal ownership itself; a caller cannot submit another account ID to the
settings API. Paired devices cannot borrow the desktop session for secret management.
They remain trusted to execute code in the desktop's workspaces, including access to
application values available to those processes.

AGNT owns secret persistence, encryption, scope resolution and sandbox injection.
The existing resolver supplies both readiness metadata and provisioning selection.
No database migration, SDK version bump, Agent Server change or additional
encryption key is needed for this feature.

## Qualification and rollout

Tests cover real Postgres authentication/authorization, scope precedence, immutable
workspace ownership on refresh, account-change cancellation, and both UI transport
paths. The opt-in E2B test verifies setup commands, sourced `.env`, and the running
sidecar process, including multiline values, replacement, deletion and VM cleanup.
It uses local authenticated platform routes and real E2B steps; production deployment
and the complete Queue/Durable Object lifecycle are outside that test.

Deploy the AGNT backend routes before releasing the Deus UI. The platform's existing
`ENCRYPTION_KEY` binding must remain available. No production deploy is performed by
the tests. See [browser test instructions](../test/e2e/README.md).
