/** Hosted assistants (ChatGPT, Claude, a CLI agent) that reach this computer through the Deus account. */

/** What a person decided: nothing yet, the tools that only read, every tool, or no. */
export type AssistantAccess = "pending" | "read" | "operate" | "denied";

/** What a person may set an assistant's access to: anything but "nothing yet". */
export type AssistantDecision = Exclude<AssistantAccess, "pending">;

export interface Assistant {
  /** The assistant's OAuth client id at the sign-in service. */
  clientId: string;
  /** A label for people; never used to decide anything. The assistant chooses it. */
  name: string;
  /**
   * Where its sign-in returns to (`chatgpt.com`): the one thing about it the
   * assistant cannot choose freely. Null until Deus Cloud has told us.
   */
  host: string | null;
  access: AssistantAccess;
  /** Epoch ms of its first contact with this computer. */
  createdAt: number;
  /** Epoch ms of its latest connection. */
  lastSeenAt: number;
}
