---
name: deus-remote-lab
description: Drive a disposable remote-access stack (a fixture Mac, the relay, Deus Cloud, paired devices and assistants) one command at a time. Use when changing or testing the relay, the tunnel, pairing and device grants, the runtime client’s reconnection, files through the relay, or assistants, and when reproducing a remote-access report.
---

# Deus remote lab

From the Deus checkout with Node 22 and Bun, check that Docker prints its server version and Node’s SQLite binding prints `1`.

```sh
docker info --format '{{.ServerVersion}}'
node -e 'const db = require("better-sqlite3")(":memory:"); console.log(db.prepare("select 1").pluck().get()); db.close()'
```

Use a local Docker socket and start its daemon only if it is down. If Node cannot load the binding, run `bun run native:node` and repeat the check.
Set `AGNT_WORKSPACE` in the environment to a local AGNT checkout’s absolute path, with worker dependencies installed and `packages/api` and `packages/sdk` built.
Pairing and restart run headless. Only the browser suite needs Chromium (`bunx playwright install chromium`, see `test/e2e/README.md`).

Run the lab on a network you trust. The relay and Deus Cloud listen on loopback. The fixture Mac listens on all interfaces while remote access is on.
Network callers need to pair, and only this computer can issue a pairing code. Use fixture accounts and keep the lab away from production services.
In both shells, run `lab() { bun run deus-remote-lab "$@"; }` from the same checkout. See `lab --help` for syntax.

The recipes share one session. To start partway through, bring the lab up and pair the devices you need (`phone` watches, `writer` makes changes).

## First session in five commands

```sh
lab up
lab status
lab device pair phone
lab host devices
lab device call phone repos
```

Look for `phone` in the approvals and `Remote test` in the read. Run `lab down` when finished. The lab also shuts down after 30 idle minutes.
If `up` reports “Lab is already up or starting”, `status` shows the phase, devices and idle timeout.
After a `kill -9` of the daemon, read `status` before the next `up` replaces `lab.json`. Use `last` to identify and manually remove any surviving lab processes and Postgres container.
The next `up` starts in a fresh directory with a unique container name and newly allocated ports.

## Pair a second device and see the approval

Capture the Mac’s one-use code privately and record the issuer’s exit (`$?`).

```sh
issued=$(lab host code)
```

On success, record `{"code":"[REDACTED]"}`. Quote the two words and suppress Bun’s command echo when pairing.

```sh
code=$(printf '%s\n' "$issued" | bun -e 'console.log((await Bun.stdin.json()).code)')
lab device pair writer "$code" 2>/dev/null
lab host devices
```

Check `host devices` for two distinct approvals under `user_alice`.
`status.devices` lists the lab’s device handles and keeps `phone` even after revocation.

## Read and follow a workspace

In shell A, keep the live read open through the edit and the restart below.

```sh
lab device follow phone workspaces --for 90
```

After the first snapshot, rename the seeded workspace in shell B. Wait for the new title in shell A before restarting the host.

```sh
ws_id=$(lab device call writer workspaces | bun -e 'const {data} = await Bun.stdin.json(); console.log(data.flatMap(g => g.workspaces).find(w => w.slug === "remote").id)')
lab device call writer updateWorkspaceTitle "{\"workspaceId\":\"$ws_id\",\"title\":\"From writer\"}"
```

## Break the connection and check what returns

In shell B, save the phone’s last sequence number. `--since` returns entries strictly after it for that device.
Compare `services.host` before and after restart. The new host process keeps the database, approvals and log path. Its PID and address can change.

```sh
seq=$(lab device state phone | bun -e 'console.log((await Bun.stdin.json()).entries.at(-1).seq)')
lab status
lab fault host-restart
lab status
lab device wait phone online --timeout 60
lab device state phone --since "$seq"
```

Check that the phone leaves `online`, returns and gets a fresh snapshot with the saved title.
Match each `snapshot`, `delta`, `event` or `reset` follow line to the `receive` entry in `device state` with the same `seq` and `ms`.
For a reset the client emits on return, that entry is the authentication reply. The follow ends with a separate count.

To check an unnumbered stream, take a fresh checkpoint in shell B **before** starting the terminal follow.

```sh
seq=$(lab device state phone | bun -e 'console.log((await Bun.stdin.json()).entries.at(-1).seq)')
```

Start the follow in shell A and leave it running across the drop.

```sh
lab device follow phone terminalOutput '{"id":"probe"}' --for 60
```

Run these lines individually in shell B. Before **each** print, repeat the `--since` read until it shows a `receive` entry with `frame: "q:subscribed"`.
An online phone can still miss a short-lived terminal’s output while its subscription is pending. Wait for the first terminal’s exit in shell A before taking the second checkpoint.

```sh
lab device state phone --since "$seq"
lab device call writer ptySpawn '{"id":"probe","command":"/bin/echo","args":["before"]}'
seq=$(lab device state phone | bun -e 'console.log((await Bun.stdin.json()).entries.at(-1).seq)')
lab fault drop phone
lab device wait phone online --timeout 30
lab device state phone --since "$seq"
lab device call writer ptySpawn '{"id":"probe","command":"/bin/echo","args":["after"]}'
```

Expect a reset on its own line between the two terminal outputs. Only `sessionEvents` is resumable.
After a relay restart or dropped socket, expect each retained missed event once, in order. After a host restart, expect a reset and reread the chat.

## Add an assistant and call a tool

```sh
lab assistant add
lab assistant tools
lab assistant call whoami
```

Find `whoami` in the list. Its reply should identify the assistant by the `clientId` from `assistant add` and show `access: read`.

## Revoke and restart

Run these commands individually. Expect `Runtime access is revoked` on the phone’s read and a timeout on its online wait. Continue to `down` after both.

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

After restart, verify that the approved writer can read and the original phone stays `revoked`. Pairing it again would create a new grant.

## Hand over the evidence

Chain dependent steps on exit 0. A failure, including a failed `up`, exits 1. Read `reason` and the log named by `status`.
Exit 2 means a command timed out while the lab stayed up, including a wait, a live follow that got no snapshot or a command past `--timeout`.
A timed-out wait includes only entries seen during the wait. Use `device state` for earlier history.
Lab devices probe every 300 ms and declare a connection dead after 5 s without a reply, much faster than the app, so outages show within seconds and ping/pong frames fill the log.
Skip `ping` and `pong` frames when reading other transitions. Keep them as evidence for `blackhole`.
Hand over the commands, JSON, exit codes, state transitions, follow lines and log paths.

## What the lab cannot test

- Test phone screens in the iOS app’s own tests, outside this repository.
- For a deployed-relay report, get the maintainer’s approval before deploying a staging relay by hand.
- Use a transport-level test for the relay’s view of a dead peer. Under `blackhole`, the device’s socket still answers protocol pings.
- The lab cannot produce a chat turn, so it cannot test chat event replay or an agent’s question.
