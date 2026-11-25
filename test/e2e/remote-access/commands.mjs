// The command socket carries argv, so the daemon validates the same input as the CLI.
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { decodeJwt } from "jose";

export const help = `deus-remote-lab — drive a disposable Deus stack on loopback
Set AGNT_WORKSPACE to a local AGNT checkout with its worker dependencies installed.
Run bun run deus-remote-lab <command> [--timeout <seconds>].

  up                                      Start and sign in the fixture Mac
  status                                  Show processes, addresses, logs and idle timeout
  down                                    Stop the lab and its stack
  client-session                          Get Alice's fixture web session for an outside client
  host code                               Get a one-use pairing code
  host devices                            List approvals with their names and IDs
  host revoke <name-or-id>                Revoke one approval
  device pair <name> [code]               Pair and connect. Quote a two-word code
  device call <name> <op> [json]          Read or write through the device
  device follow <name> <stream> [json] --for <seconds>
                                          Stay subscribed across reconnects; emit each event, reset or live update as a JSON line
  device state <name> [--since <seq>]     Read state and log entries after seq
  device wait <name> <state>              Wait for offline, connecting, online, revoked or disposed
  fault host-restart                      Restart the Mac with the same database
  fault relay-restart                     Restart the relay with its stored state
  fault cloud-away | cloud-back           Stop or start Deus Cloud
  fault cloud-slow <milliseconds>         Delay each side of device ticket fetches (0 clears)
  fault drop <name>                       Terminate the device's current socket
  fault blackhole <name> on|off           Suppress application frames in both directions
  assistant add                           Connect the MCP client and approve Read access
  assistant tools                         List the advertised tools
  assistant call <tool> [json]            Call a tool with the approved assistant

Timeout defaults to 120 seconds. JSON arguments are objects. A successful follow
ends with a count. Exit codes are 0 for done, 2 for a timeout while the lab is
still up, and 1 for other failures, including failed startup. A timed-out device
wait includes its state and observed entries.`;

export function failure(error, labRunning) {
  // Node's socket and child-process APIs wrap an expired AbortSignal as the cause.
  const cause = error.cause?.name === "TimeoutError" ? error.cause : error;
  return {
    reason: cause.message,
    exitCode: labRunning && cause.name === "TimeoutError" ? 2 : 1,
    ...(error.entries ? { state: error.state, entries: error.entries } : {}),
  };
}

function number(text, label, min, max = 2_147_483_647) {
  const n = Number(text);
  if (!text?.trim() || !Number.isFinite(n) || n < min || n > max)
    throw new Error("Invalid " + label);
  return n;
}
export function parse(argv) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      timeout: { type: "string", default: "120" },
      since: { type: "string" },
      for: { type: "string" },
    },
  });
  const group = positionals.shift();
  const command = ["host", "device", "fault", "assistant"].includes(group)
    ? group + " " + (positionals.shift() ?? "")
    : group;
  if (["up", "down", "status"].includes(command) && positionals.length)
    throw new Error(command + " takes no arguments");
  if (values.since !== undefined && command !== "device state")
    throw new Error("--since belongs to device state");
  if (values.for !== undefined && command !== "device follow")
    throw new Error("--for belongs to device follow");
  const timeout = Math.ceil(number(values.timeout, "timeout", 0.001, 2_147_482) * 1000);
  const since = number(values.since ?? "0", "sequence", 0, Number.MAX_SAFE_INTEGER);
  if (!Number.isSafeInteger(since)) throw new Error("Sequence must be an integer");
  const duration =
    command === "device follow"
      ? number(values.for, "--for duration", 0.001, 2_147_483) * 1000
      : undefined;
  return { command, args: positionals, timeout, since, duration };
}
function params(raw) {
  const value = JSON.parse(raw ?? "{}");
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a JSON object");
  return value;
}
export async function runCommand(lab, { command, args, since, duration }, signal, emit) {
  function arity(min, max = min) {
    if (args.length < min || args.length > max)
      throw new Error("Wrong arguments for " + command + " (see --help)");
  }
  function device() {
    const d = lab.devices.get(args[0]);
    if (!d) throw new Error("Unknown device: " + args[0]);
    return d;
  }
  const [name, op, raw] = args;
  switch (command) {
    case "client-session": {
      arity(0);
      const sessionToken = lab.sessions.aliceWeb;
      const { sub: accountId, exp } = decodeJwt(sessionToken);
      const expiresAt = new Date(exp * 1000).toISOString().replace(".000Z", "Z");
      return { accountId, sessionToken, expiresAt };
    }
    case "host code":
      arity(0);
      return { code: await lab.code() };
    case "host devices":
      arity(0);
      return { devices: await lab.hostDevices() };
    case "host revoke": {
      arity(1);
      const matches = (await lab.hostDevices()).filter((d) => d.id === name || d.name === name);
      if (matches.length !== 1) throw new Error("Select one approved device by name or ID");
      await lab.revoke(matches[0].id);
      return { revoked: matches[0].name };
    }
    case "device pair": {
      arity(1, 2);
      if (lab.devices.has(name)) throw new Error("Device name already in use: " + name);
      const machineId = (await lab.relayStatus()).serverId,
        bearer = lab.sessions.aliceWeb;
      const grant = await lab.pair(bearer, machineId, op ?? (await lab.code()), name);
      const d = lab.viewer(name, { bearer, grant, machineId });
      await d.runtime.connect();
      return { device: name, state: d.runtime.getState() };
    }
    case "device state":
      arity(1);
      return device().state(since);
    case "device wait":
      arity(2);
      return device().wait(op, signal);
    case "device call": {
      arity(2, 3);
      // The CLI imports this module for every command. Only a device call needs the API here.
      const { ops } = await import("../../../shared/api/index.ts");
      const { runtime } = device(),
        decl = ops.find((d) => d.name === op);
      if (!decl) throw new Error("Unknown operation: " + op);
      const input = decl.input.parse(params(raw));
      if (decl.kind === "read") return { data: await runtime.sendRequest(op, input) };
      const answer = await runtime.sendMutate(op, input);
      if (!answer.success) throw new Error(answer.error ?? "Mutation refused");
      return { data: answer.data ?? null };
    }
    case "device follow": {
      arity(2, 3);
      let count = 0;
      const refused = new AbortController();
      const stopped = AbortSignal.any([signal, refused.signal]);
      const { stop, live } = device().follow(
        op,
        params(raw),
        (row) => {
          emit(row);
          count++;
        },
        (error) => refused.abort(error)
      );
      try {
        await sleep(duration, undefined, { signal: stopped });
        if (live && !count)
          throw new DOMException("No snapshot arrived during the follow", "TimeoutError");
        return { done: true, count };
      } catch (error) {
        throw stopped.reason ?? error;
      } finally {
        stop();
      }
    }
    case "fault host-restart":
      arity(0);
      await lab.stop("host");
      await lab.startHost();
      await lab.signIn();
      if (lab.cloud) await lab.connectedAs();
      break;
    case "fault relay-restart":
      arity(0);
      await lab.stop("relay");
      await lab.startRelay();
      if (lab.cloud) await lab.connectedAs();
      break;
    case "fault cloud-away":
      arity(0);
      await lab.stop("cloud");
      break;
    case "fault cloud-back":
      arity(0);
      if (lab.cloud) throw new Error("Deus Cloud is already up");
      await lab.startCloud();
      break;
    case "fault cloud-slow":
      arity(1);
      lab.latencyMs = number(name, "delay in milliseconds", 0);
      break;
    case "fault drop":
      arity(1);
      device().drop();
      break;
    case "fault blackhole":
      arity(2);
      if (!["on", "off"].includes(op)) throw new Error("Use on or off");
      device().blackhole = op === "on";
      break;
    case "assistant add": {
      arity(0);
      if (lab.assistant) throw new Error("Assistant already added");
      const a = await lab.addAssistant("Lab assistant", "http://127.0.0.1/callback");
      await lab.host.write("setAssistantAccess", { clientId: a.clientId, access: "read" });
      lab.assistant = a;
      return { clientId: a.clientId, access: "read" };
    }
    case "assistant tools":
    case "assistant call": {
      if (!lab.assistant) throw new Error("Run assistant add first");
      if (command === "assistant tools") {
        arity(0);
        return lab.assistant.client.listTools();
      }
      arity(1, 2);
      const answer = await lab.assistant.call(name, params(op));
      if (answer.isError) throw new Error(answer.text);
      return answer;
    }
    default:
      throw new Error("Unknown command (see --help)");
  }
  return { fault: command.slice(6), applied: true };
}
