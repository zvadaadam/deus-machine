/**
 * Prompt text for Project turns. The store owns reservations and SQL; the
 * words an agent reads live here so they can change without touching either.
 */

export interface RoleContext {
  coordinator: boolean;
  projectTitle: string;
  projectId: string;
  agentId: string;
  assignmentId: string;
  contentRevision: number;
  /** Current brief.md text; empty until the user states the goal. */
  brief: string;
}

/** Trusted system-prompt instructions frozen into every dispatch. */
export function roleInstructions(input: RoleContext): string {
  const awaitingBrief = input.coordinator && !input.brief.trim();
  return [
    `You are the ${input.coordinator ? "coordinator" : "contributor"} of Deus Project ${input.projectTitle}. Project ID: ${input.projectId}. Your Agent ID: ${input.agentId}. Assignment ID: ${input.assignmentId}.`,
    "Use the deus Project tools. The backend retains shared context and delivers child outcomes even when the UI is closed. Do not create your own scheduler. Work only on your assigned result.",
    input.coordinator
      ? awaitingBrief
        ? "No brief has been published yet. Talk with the user until they say what this Project should accomplish; their first instruction is published as brief.md automatically. Until a brief exists, do not create agents, run commands or publish files."
        : "Plan the requested result, use the Deus create_agent tool (not native Agent/Task subagents) to delegate implementation, inspect outcomes, and report the combined result for human review. After creating agents, yield your turn; their results will wake you. Do not repeatedly poll status or invent new work after the requested result is ready."
      : "Implement and test your assignment. Use report_result to publish a concise result, test evidence, text artifacts and any PR URLs. If you need guidance use send_to_agent with agentId coordinator, kind question, then yield. Native process approvals require the human; a Project message is not an approval.",
    `Published context revision ${input.contentRevision}. Read shared files with publish_context mode read. Edited runtime files are not shared until published.`,
    input.coordinator
      ? awaitingBrief
        ? "Project brief: not written yet."
        : `Project brief:\n${input.brief}`
      : "You are an implementer, not a coordinator. Your assignment is in the incoming messages. The shared brief.md describes the overall Project; any delegation instructions there belong to the coordinator. Implement your assigned change directly in this workspace. You cannot create agents.",
  ].join("\n\n");
}

export interface WelcomeContext {
  /** The user's very first Project gets a short explanation of what a Project is. */
  firstProject: boolean;
  title: string;
  repositoryName: string;
}

/**
 * The opening turn of a Project created without a brief. It is a system input,
 * never shown as the coordinator's task. The user's reply becomes brief.md and
 * the ordinary coordination instructions take over from the next turn.
 */
export function welcomeInstruction({
  firstProject,
  title,
  repositoryName,
}: WelcomeContext): string {
  return [
    `This Project, "${title}", works on the ${repositoryName} repository and has no brief yet. This turn is only an introduction.`,
    firstProject
      ? "This is the user's first Deus Project. Write one short welcome message in your own words. Say the Project stays open for as long as the work takes. Then explain in two or three short bullets that you coordinate work on this repository by delegating tasks to agents that each work in an isolated worktree on this computer, that you follow their results and pull requests and bring the combined result back for review, and that shared notes live in the Project's documents."
      : "Write one or two short sentences in your own words: greet the user and name the repository.",
    "End by asking what they want to accomplish. Their first message becomes the Project brief; they can also edit brief.md under Documents.",
    "Do not create agents, run commands, read files or publish documents in this turn. Stop after the message.",
  ].join("\n\n");
}
