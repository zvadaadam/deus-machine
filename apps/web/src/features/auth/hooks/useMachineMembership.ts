import { useEffect, useState } from "react";
import {
  expireRelayAccount,
  listMachines,
  markMachineUnavailable,
  RelayTicketError,
  type RelayAccount,
  type RemoteMachine,
} from "@/platform/ws/relay-access";

/**
 * Before asking for approval, check that the account has this computer at all:
 * another account's link should say so, not offer a pairing that cannot work.
 * A device with a grant learns the same from its first dial instead.
 */
export function useMachineMembership(
  account: RelayAccount | null,
  machineId: string,
  enabled: boolean
): { status: "checking" | "known"; machine: RemoteMachine | null } {
  const key = enabled && account ? `${account.accountId}:${machineId}` : null;
  const [checked, setChecked] = useState<string | null>(null);
  const [machine, setMachine] = useState<RemoteMachine | null>(null);

  useEffect(() => {
    if (!key || !account) return;
    let current = true;
    listMachines(account).then(
      (machines) => {
        if (!current) return;
        const found = machines.find((candidate) => candidate.id === machineId) ?? null;
        if (!found) markMachineUnavailable(account.accountId, machineId);
        // Named on the approval page, so a code is only ever typed into this computer.
        setMachine(found);
        setChecked(key);
      },
      (error: unknown) => {
        if (!current) return;
        if (error instanceof RelayTicketError && error.kind === "expired") {
          expireRelayAccount(account);
        }
        // Unknown (e.g. Deus Cloud unreachable): pairing reports its own failure.
        setChecked(key);
      }
    );
    return () => {
      current = false;
    };
  }, [key, account, machineId]);

  return { status: key && checked !== key ? "checking" : "known", machine };
}
