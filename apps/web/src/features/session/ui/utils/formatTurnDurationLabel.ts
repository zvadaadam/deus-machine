export function formatTurnDurationLabel(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const seconds = totalSeconds % 60;

  const parts = [
    { value: hours, label: "h" },
    { value: minutes, label: "m" },
    { value: seconds, label: "s" },
  ].filter((part) => part.value > 0);

  if (parts.length === 0) return "0s";

  return parts
    .slice(0, 2)
    .map((part) => `${part.value}${part.label}`)
    .join(" ");
}
