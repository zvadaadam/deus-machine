# Analytics Patterns (PostHog Integration)

## Architecture

- `src/platform/analytics/` — new module: `events.ts`, `track.ts`, `useAnalyticsConsent.ts`, `index.ts`
- `events.ts` is the single source of truth for `AnalyticsEventMap` (25 events as of first integration)
- `track<E>(event, ...args)` is type-safe via conditional spread: zero args for `Record<string, never>` events
- `posthog-js` is the only dependency. `PostHogProvider` wraps `<App>` in `main.tsx`.
- `posthog-js/react` is a subpath export of `posthog-js` — no separate package needed.

## Consent Model

- OPT-OUT (default ON). `analytics_enabled?: boolean` in `Settings` — `undefined` = ON, `false` = OFF.
- `useAnalyticsConsent()` syncs PostHog opt-in/out state with the setting. Called once in `AppContent`.
- `prevEnabled` ref prevents re-syncing on unrelated setting changes.
- `setAnalyticsEnabled()` in `track.ts` sets a module-level `_enabled` bool + calls PostHog opt_in/out.
- **Comment bug fixed**: `shared/types/settings.ts` comment now correctly says "opt-out, default true when absent".
- `_enabled` in `track.ts` defaults to `false` (consent-first). Tracking starts disabled until
  `useAnalyticsConsent` syncs.

## Known Bugs (Fixed)

- **app_launched multi-fire** — FIXED: `appLaunchTracked` ref guard in `useAnalyticsConsent.ts`
  ensures `app_launched` fires at most once per app lifecycle.
- **onboarding_started StrictMode double-fire** — FIXED: `onboardingTrackedRef` guard in
  `OnboardingOverlay.tsx` prevents React 18 StrictMode remount from double-counting.

- **onboarding_step_viewed never fires for step 0 (Welcome)**: `goForward` tracks the _destination_ step,
  so the welcome screen (step 0) is never tracked. Only steps 1–4 are captured. Acceptable as-is since
  `onboarding_started` covers "user saw welcome." But step funnels in PostHog will be off-by-one for step 0.

- **goBack does NOT track onboarding_step_viewed**: stepping backwards emits no analytics. Users going
  back to a previous step are invisible in the funnel.

## Event Wiring Status

- `repo_removed` is in the map with a `TODO` comment — no track() call anywhere. Intentional stub.
- `open_in_app` fires from TWO locations: `WorkspaceHeader.tsx` (no workspace_id available, field omitted)
  and `OpenInDropdown.tsx` (workspace_id also not included — the component only receives workspacePath, not workspaceId).
  Both are correct per the optional `workspace_id?: string` in the event map.
- `pr_merged` and `pr_create_requested` are intent events (fire before agent action). Acceptable.
- `setting_changed` fires once per key in `Partial<Settings>` — if a batch update changes 3 keys, 3 events fire.
- `session_message_sent` fires in `onSettled` with `!error` guard — only on HTTP success, not failure.

## PostHog Public Key

- `VITE_PUBLIC_POSTHOG_KEY` in `.env.example` is a real write-only ingestion key (`phc_` prefix).
  This is standard practice for PostHog — ingestion keys are public and safe to commit.
  They cannot read data; they can only write events. Not a security issue.

## Tailwind Note

- `PostHogProvider` has no styling concerns — pure data provider, no DOM output.
