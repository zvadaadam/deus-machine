---
name: deus-remote-lab
description: Drive a disposable remote-access stack on loopback (a fixture Mac, the relay, Deus Cloud, paired devices and assistants) one command at a time. Use when changing or testing the relay, the tunnel, pairing and device grants, the runtime client’s reconnection, files through the relay, or assistants, and when reproducing a remote-access report.
---

# Deus remote lab

Use Node 22 and Bun in the Deus checkout. Check Docker and Node’s SQLite binding before starting the lab.
Docker prints its server version when it is running. The SQLite check should print `1`.

```sh
docker info --format '{{.ServerVersion}}'
node -e 'const db = require("better-sqlite3")(":memory:"); console.log(db.prepare("select 1").pluck().get()); db.close()'
```

Start Docker only if the daemon is down. If Node cannot load the binding, run `bun run native:node` and repeat the check.
Export `AGNT_WORKSPACE` as the absolute path to a local AGNT checkout with its worker dependencies
installed and `packages/api` and `packages/sdk` built. The lab runs Deus Cloud from that checkout.
Pairing and restart run headless, with no browser or foreground app. Only the browser suite needs
Chromium (`bunx playwright install chromium`, as described in `test/e2e/README.md`).

The lab creates fixture accounts and runs every service on loopback. Never point it at a production service or use a real account.
In each shell, run `lab() { bun run deus-remote-lab "$@"; }` from the same checkout so both shells reach the same lab.
Use `lab --help` for command syntax.

The recipes continue one session. To start partway through, bring the lab up and pair the devices your recipe uses
(`phone` watches and `writer` makes changes). For recovery, start the indicated follow in shell A before applying the fault in shell B.

## First session in five commands

```sh
lab up
lab status
lab device pair phone
lab host devices
lab device call phone repos
```

Look for `phone` in the Mac’s approvals and `Remote test` in the device’s read. Run `lab down` when finished.
The lab also stops after 30 minutes without a command. Check `status` for the timeout and log paths.
If `up` reports “Lab is already up or starting”, check `status` for the existing lab’s phase and devices.
After a `kill -9` of the daemon, read `status` before the next `up` replaces `lab.json`. Use `last` to identify and manually remove any surviving lab processes and Postgres container.
The next `up` starts in a fresh directory with a unique container name and newly allocated ports.

## Pair a second device and see the approval

Capture the Mac’s one-use code privately. This assignment preserves the issuer’s exit code.

```sh
issued=$(lab host code)
```

Record the exit (`$?`) before pairing. On success, show the issuer’s JSON as `{"code":"[REDACTED]"}`.
Quote the two words and suppress Bun’s command echo. Keep the pairing JSON and exit separate from the issuer’s.

```sh
code=$(printf '%s\n' "$issued" | bun -e 'console.log((await Bun.stdin.json()).code)')
lab device pair writer "$code" 2>/dev/null
lab host devices
```

Check `host devices` for two distinct approvals under `user_alice`. Use that list to answer who is approved.
`status.devices` lists the lab’s device handles and keeps `phone` even after revocation.

## Read and follow a workspace

In shell A, keep the live read open through the edit and the restart below.

```sh
lab device follow phone workspaces --for 90
```

After the first snapshot, rename the seeded workspace in shell B using this run’s ID.
Check shell A for the new title before restarting the host.

```sh
ws_id=$(lab device call writer workspaces | bun -e 'const {data} = await Bun.stdin.json(); console.log(data.flatMap(g => g.workspaces).find(w => w.slug === "remote").id)')
lab device call writer updateWorkspaceTitle "{\"workspaceId\":\"$ws_id\",\"title\":\"From writer\"}"
```

## Break the connection and check what returns

In shell B, save the phone’s last sequence number. `--since` returns entries strictly after that number for that device.
Compare `services.host` in the two status results. The restart replaces the fixture host process, so its PID and address can change.
Its database, device approvals and host log path carry over.

```sh
seq=$(lab device state phone | bun -e 'console.log((await Bun.stdin.json()).entries.at(-1).seq)')
lab status
lab fault host-restart
lab status
lab device wait phone online --timeout 60
lab device state phone --since "$seq"
```

Check for the loss of `online` and its return in sequence order. Require a fresh snapshot with the saved title after reconnection.
Match each `snapshot`, `delta`, `event` or `reset` follow line to the `receive` entry in `device state` with the same `seq` and `ms`.
A reset the client emits on return carries the authentication frame’s `seq` and `ms`. The follow ends with a separate count.

To check an unnumbered stream, follow the output of a named fixture terminal in shell A.

```sh
lab device follow phone terminalOutput '{"id":"probe"}' --for 60
```

In shell B, have the writer print once. When shell A shows the output, drop the phone socket.
After the wait, print again. Expect a reset on its own JSON line between the two outputs.

```sh
lab device call writer ptySpawn '{"id":"probe","command":"/bin/echo","args":["before"]}'
lab fault drop phone
lab device wait phone online --timeout 30
lab device call writer ptySpawn '{"id":"probe","command":"/bin/echo","args":["after"]}'
```

Only `sessionEvents` is resumable. After a relay restart or dropped socket, expect each missed
event still held by the host once, in order. After a host restart, expect a reset and read the
chat again because the host has lost its replay history.

## Add an assistant and call a tool

```sh
lab assistant add
lab assistant tools
lab assistant call whoami
```

Find `whoami` in the list. Its reply should identify the assistant by the `clientId` from `assistant add` and show `access: read`.

## Revoke and restart

Run these commands individually. Continue after the revoked phone’s read exits 1 with `Runtime access is revoked` and its online wait exits 2.

```sh
lab host revoke phone
lab device wait phone revoked --timeout 30
lab device call phone repos
writer_seq=$(lab device state writer | bun -e 'console.log((await Bun.stdin.json()).entries.at(-1).seq)')
lab fault host-restart
lab device wait writer online --timeout 60 && lab device call writer repos
lab device state writer --since "$writer_seq"
lab status
lab host devices
lab device wait phone online --timeout 3
lab device state phone
lab down
```

Expect both handles in `status` but only `writer` in the approvals. Verify that the writer’s read succeeds
after restart and the same phone stays `revoked`. Pairing it again would create a new grant.

## Hand over the evidence

Chain dependent steps on exit 0. For an unexpected exit 1, read `reason` and the component log named by `status`.
A timed-out wait exits 2 and includes only entries seen during the wait, possibly none. Read `device state` for earlier history.
Keep ping and pong in the log as evidence for `blackhole`. When reading other transitions, skip entries whose `frame` is `ping` or `pong`.
Hand over commands, JSON, exit codes, numbered state transitions, follow lines and the log paths from `status`. Omit pairing codes.

## What the lab cannot test

- Test phone screens in the iOS app’s own tests, outside this repository.
- For a deployed-relay report, get the maintainer’s approval before deploying a staging relay by hand.
- Use a transport-level test for the relay’s view of a dead peer. Under `blackhole`, the device’s socket still answers protocol pings.
- Leave chat event replay and an agent’s question for the second cut, which needs a model-free turn.
