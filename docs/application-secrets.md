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

Open a repository to edit one shared Setup and Run recipe, with optional local/cloud
command overrides. The effective source is the checkout's `.deus/environment.json`,
then saved project settings. Secrets remain below the form and retain their existing
scopes. See [Project environments](project-environments.md) for source selection,
publication, setup execution and the SDK boundary.

**Set up with agent** starts a normal workspace with the selected local/cloud target
and composer model. It currently requires a repository added to Deus. The agent
edits the repository file when present; otherwise its configuration tool can save
public commands and required names for future cloud workspaces. That tool cannot
persist secret values.

Secrets added on a repository page apply to that recipe automatically. Default
secrets have their own page and cannot be edited accidentally from a repository.
Cloud secrets are not injected into local processes by this feature.

Cloud Run is a foreground app command that AGNT starts in the background after
setup in a new VM. Pause/resume preserves it; VM recreation starts it again. Saving
scripts does not restart an existing app. AGNT's `config.run`, `Environment.run()`
SDK builder and the agent configuration tool use the same runtime path.

Drop an `.env` or `.dev.vars` file into Cloud environment variables, or click to
choose a file. The review lists names and whether each value will be added or
replaced. Empty values are visibly skipped; duplicates and malformed lines must be
corrected before import. Shell expansion syntax stays literal. Values used by
multiple environments cannot be replaced by a one-repository import; use the
existing Replace action to retain that scope.

Selected values are written in one transaction. Adding the first secret can create
the repository environment without saving script drafts. Organization owners and
admins can create that shared record; members can add personal values once it exists.

## Behavior

- A signed-in member can save personal values. Organization owners and admins can
  also manage shared values.
- Each value applies to all environments or a selected recipe. Effective precedence
  is personal environment → shared environment → personal default → shared default.
- Settings returns names, ownership, scope and required-value status. Saved values
  are never returned. Replacement requires a new value; deletion can reveal a lower
  priority value with the same name.
- AGNT's secret store makes writes and scope changes atomic, and serializes writes
  within an organization. Simultaneous saves converge on one value for the same
  owner and scope; conflicting scopes are rejected. SDK calls and dashboard imports
  use this same boundary, including when they already have an outer transaction.
- Required values are counted as set when the selected recipe has an effective secret
  or a nonempty public configuration value. This does not validate the key with its
  provider or prove that an app builds successfully.
- Public variables live in the selected project recipe. Application secrets
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
The SDK already offers environment and secret APIs for organization-key clients.
The dashboard API enforces signed-in human ownership while reusing the same store;
substituting a privileged SDK key would lose that distinction. Project configuration uses the shared API/SDK schema. Secret persistence needs no
Agent Server change or additional encryption key.

## Qualification and rollout

Tests cover real Postgres authentication/authorization, scope precedence, immutable
workspace ownership on refresh, account-change cancellation, and both UI transport
paths. Concurrent-write tests cover shared/personal defaults and repository values,
overlapping scopes, SDK/import writes and inline environment creation. Browser tests
switch accounts with the same name at all four precedence levels; database tests
verify the selected value after each override is deleted.
The opt-in E2B test verifies setup commands, sourced `.env`, and the running
sidecar and Run-script HTTP app, including multiline values, same-process
pause/resume, replacement, deletion, recreation and VM cleanup. Browser tests cover
both file selection and dropping, draft preservation during environment creation,
and excluding conflicting scopes from imports.
It uses local authenticated platform routes and real E2B steps; production deployment
and the complete Queue/Durable Object lifecycle are outside that test.

Deploy the AGNT backend routes before releasing the Deus UI. The platform's existing
`ENCRYPTION_KEY` binding must remain available. No production deploy is performed by
the tests. See [browser test instructions](../test/e2e/README.md).
