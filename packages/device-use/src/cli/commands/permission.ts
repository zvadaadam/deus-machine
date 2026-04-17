import { z } from "zod";
import type {
  CommandDefinition,
  CommandResult,
  PermissionAction,
  PermissionService,
} from "../../engine/types.js";
import { setPermission } from "../../engine/simctl.js";
import { ValidationError } from "../../engine/errors.js";
import { resolveCommandSetup } from "../runtime.js";

const SERVICES: PermissionService[] = [
  "all",
  "calendar",
  "contacts-limited",
  "contacts",
  "location",
  "location-always",
  "photos-add",
  "photos",
  "media-library",
  "microphone",
  "motion",
  "reminders",
  "siri",
];

const ACTIONS: PermissionAction[] = ["grant", "revoke", "reset"];

const schema = z.object({
  _positionals: z.array(z.string()).optional(),
});

type Params = z.infer<typeof schema>;

export const permissionCommand: CommandDefinition<Params> = {
  name: "permission",
  aliases: ["privacy"],
  description: "Grant, revoke, or reset a privacy permission for an app",
  usage: "permission <grant|revoke|reset> <service> [<bundleId>]",
  examples: [
    "permission grant location com.apple.Maps",
    "permission revoke photos ai.deus.machine",
    "permission reset all ai.deus.machine",
    "permission reset all",
  ],
  schema,
  async handler(params, ctx): Promise<CommandResult> {
    const setup = await resolveCommandSetup(ctx);
    if (!("udid" in setup)) return setup;

    const [actionRaw, serviceRaw, bundleId] = params._positionals ?? [];

    if (!actionRaw || !serviceRaw) {
      throw new ValidationError("Usage: permission <grant|revoke|reset> <service> [<bundleId>]");
    }

    if (!ACTIONS.includes(actionRaw as PermissionAction)) {
      throw new ValidationError(`Invalid action "${actionRaw}". Use one of: ${ACTIONS.join(", ")}`);
    }
    if (!SERVICES.includes(serviceRaw as PermissionService)) {
      throw new ValidationError(
        `Invalid service "${serviceRaw}". Use one of: ${SERVICES.join(", ")}`
      );
    }

    const action = actionRaw as PermissionAction;
    const service = serviceRaw as PermissionService;

    await setPermission(ctx.executor, setup.udid, action, service, bundleId);

    const target = bundleId ?? "all apps";
    return {
      success: true,
      message: `${action} ${service} for ${target}`,
      data: ctx.flags.json ? { action, service, bundleId: bundleId ?? null } : undefined,
      nextSteps: bundleId ? [{ command: `launch ${bundleId}`, label: "Launch the app" }] : [],
    };
  },
};
