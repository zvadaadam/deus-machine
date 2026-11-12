/** Remote access as clients read it: the devices paired with this computer and its tunnel. */

/** A device this computer approved. Its token is never part of what a client reads. */
export interface PairedDevice {
  id: string;
  name: string;
  /** The Deus account a relay pairing belongs to; null for a local-network pairing. */
  account_id: string | null;
  /** This computer's machine id in that account when it paired; null for a local-network pairing. */
  machine_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  last_seen_at: string;
  created_at: string;
  /** Connected right now, through the relay or the local network. */
  connected: boolean;
}

/** Off, waiting for the desktop's Deus sign-in, dialing, serving devices, or removed from the account. */
export type RelayState = "off" | "signed_out" | "connecting" | "connected" | "removed";

export interface RelayStatus {
  state: RelayState;
  connected: boolean;
  clients: number;
  /** This computer's id in the signed-in account (its relay routing id). */
  serverId: string | null;
  /** The name other devices see for this computer. */
  serverName: string;
  accountId: string | null;
  relayUrl: string;
  /** Why the last dial failed, while still retrying; or why the computer was removed. */
  error: string | null;
  /** This computer's OS (Node's `process.platform`), for a viewer on another device. */
  platform: string;
}
