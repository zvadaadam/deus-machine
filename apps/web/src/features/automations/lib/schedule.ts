/**
 * Schedule helpers — presets over 5-field cron.
 *
 * The stored format is the agnt platform's (cron + IANA timezone). The UI and
 * the agent tool are the translation layers: users see presets and words,
 * never raw cron (custom cron stays available behind the "Custom" preset).
 */

export type SchedulePresetId = "hourly" | "daily" | "weekdays" | "weekly" | "custom";

export const SCHEDULE_PRESETS: Array<{ id: SchedulePresetId; label: string; hasTime: boolean }> = [
  { id: "hourly", label: "Every hour", hasTime: false },
  { id: "daily", label: "Every day", hasTime: true },
  { id: "weekdays", label: "Every weekday", hasTime: true },
  { id: "weekly", label: "Every Monday", hasTime: true },
  { id: "custom", label: "Custom cron", hasTime: false },
];

export interface ScheduleForm {
  preset: SchedulePresetId;
  /** "HH:MM" for time-based presets. */
  time: string;
  /** Raw cron, only meaningful when preset === "custom". */
  cron: string;
}

function timeParts(time: string): { h: number; m: number } {
  const [h = "9", m = "0"] = time.split(":");
  return { h: Number.parseInt(h, 10) || 0, m: Number.parseInt(m, 10) || 0 };
}

export function buildCron(form: ScheduleForm): string {
  const { h, m } = timeParts(form.time);
  switch (form.preset) {
    case "hourly":
      return "0 * * * *";
    case "daily":
      return `${m} ${h} * * *`;
    case "weekdays":
      return `${m} ${h} * * 1-5`;
    case "weekly":
      return `${m} ${h} * * 1`;
    case "custom":
      return form.cron.trim();
  }
}

/** Best-effort inverse of buildCron; anything unrecognized lands on Custom. */
export function parseSchedule(cron: string): ScheduleForm {
  const trimmed = cron.trim();
  const hourly = /^(\d{1,2}) \* \* \* \*$/.exec(trimmed);
  if (hourly && hourly[1] === "0") return { preset: "hourly", time: "09:00", cron: trimmed };
  const timed = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|1)$/.exec(trimmed);
  if (timed) {
    const time = `${timed[2].padStart(2, "0")}:${timed[1].padStart(2, "0")}`;
    if (timed[3] === "*") return { preset: "daily", time, cron: trimmed };
    if (timed[3] === "1-5") return { preset: "weekdays", time, cron: trimmed };
    return { preset: "weekly", time, cron: trimmed };
  }
  return { preset: "custom", time: "09:00", cron: trimmed };
}

/** "Weekdays at 9:00" — words, never raw cron (custom shows the expression). */
export function humanizeSchedule(cron: string | null): string {
  if (!cron) return "On demand";
  const form = parseSchedule(cron);
  const at = (t: string) => {
    const { h, m } = timeParts(t);
    return `${h}:${String(m).padStart(2, "0")}`;
  };
  switch (form.preset) {
    case "hourly":
      return "Hourly";
    case "daily":
      return `Daily at ${at(form.time)}`;
    case "weekdays":
      return `Weekdays at ${at(form.time)}`;
    case "weekly":
      return `Mondays at ${at(form.time)}`;
    case "custom": {
      // Generic single-weekday crons have no preset, but the words rule
      // still holds — three built-in templates ship them.
      const single = /^(\d{1,2}) (\d{1,2}) \* \* ([0-7])$/.exec(form.cron);
      if (single) {
        const day = WEEKDAY_NAMES[Number.parseInt(single[3], 10) % 7];
        return `${day} at ${Number.parseInt(single[2], 10)}:${single[1].padStart(2, "0")}`;
      }
      return cron;
    }
  }
}

const WEEKDAY_NAMES = [
  "Sundays",
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function chunks(ms: number): string {
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MINUTE))} min`;
  if (ms < DAY) return `${Math.round(ms / HOUR)} h`;
  return `${Math.round(ms / DAY)} d`;
}

export function formatTimeUntil(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const delta = Date.parse(iso) - Date.now();
  if (!Number.isFinite(delta)) return null;
  if (delta <= 0) return "now";
  return `in ${chunks(delta)}`;
}

export function formatTimeSince(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const delta = Date.now() - Date.parse(iso);
  if (!Number.isFinite(delta)) return null;
  if (delta < MINUTE) return "just now";
  return `${chunks(delta)} ago`;
}

/** "Aug 27, 2:00" — run-history rows. */
export function formatRunWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatDuration(start: string | null, end: string | null): string | null {
  if (!start || !end) return null;
  const ms = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  return `${Math.floor(totalSeconds / 60)}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
}
