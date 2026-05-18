# prelaunch-hardening

Make Deus easier to ship before launch: schema evolution is simple, quality gates cover the risky code, and platform capabilities match what actually works. This is not a backwards-compatibility preservation project; it is a pre-launch hardening pass that removes confusing policy drift and catches real bugs earlier.

## Quality bar

Fast without being sloppy. The repo should feel like a product getting ready to ship: fewer hidden exceptions, fewer "works on my machine" platform guesses, and no ceremony that only makes sense after real users depend on persisted data.

## Sub-goals

- [x] **01 - Pre-launch schema cleanup** - `goals/01-prelaunch-schema-cleanup.md` - `Done =` database setup has one explicit pre-launch schema policy, obsolete migration baggage is removed or minimized, reset/dev upgrade behavior is documented, and CI green AND /code-review clean
- [x] **02 - Static quality gate coverage** - `goals/02-static-quality-gate-coverage.md` - `Done =` the repo's lint/static gate covers frontend, backend, agent-server, shared, packages, scripts, and tests with environment-appropriate config, and CI green AND /code-review clean
- [x] **03 - Simulator capability truth** - `goals/03-simulator-capability-truth.md` - `Done =` simulator UI is gated by backend capability and transport reality, relay/web has either a working stream path or a clear unavailable state, and CI green AND /code-review clean
- [x] **04 - High-risk complexity pass** - `goals/04-high-risk-complexity-pass.md` - `Done =` at least one highest-risk large module is simplified without behavior drift, with focused verification proving the split, and CI green AND /code-review clean
- [x] **05 - Final ship gate** - `goals/05-final-ship-gate.md` - `Done =` every prior sub-goal is checked, verification evidence is current, deferred work is explicitly logged, and CI green AND /code-review clean

## Dependencies

- 01: none
- 02: none
- 03: none
- 04: 01, 02, 03
- 05: 01, 02, 03, 04

## Done

`Done =` every box above is checked AND each sub-goal's `Done =` line is proven against current state. No exceptions.
