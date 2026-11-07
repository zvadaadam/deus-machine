import type { EditMap } from "./edit-map.js";

/** A chapter placed in a rendition. Source time is kept for editors. */
export interface OutputChapter {
  id: string;
  title: string;
  sourceMs: number;
  startMs: number;
  endMs: number;
  /** The chapter's source moment was cut; it starts where the cut lands. */
  snapped: boolean;
}

/**
 * Chapters are bookmarks, not cuts: when the edit removes time, each one
 * moves with the picture it marks. Two chapters landing on the same output
 * instant keep the later title (the earlier one has no picture left).
 */
export function mapChapters(
  chapters: Array<{ id: string; title: string; atMs: number }>,
  map: EditMap
): { chapters: OutputChapter[]; warnings: string[] } {
  const warnings: string[] = [];
  const placed = [...chapters]
    .sort((a, b) => a.atMs - b.atMs)
    .map((c) => {
      const { ms, cut } = map.toOutput(c.atMs);
      return { id: c.id, title: c.title, sourceMs: c.atMs, startMs: Math.round(ms), snapped: cut };
    });
  const unique: typeof placed = [];
  for (const chapter of placed) {
    const last = unique.at(-1);
    if (last && chapter.startMs - last.startMs < 250) {
      warnings.push(
        `Chapter "${last.title}" has no footage of its own after editing; merged into "${chapter.title}".`
      );
      unique[unique.length - 1] = chapter;
    } else {
      unique.push(chapter);
    }
  }
  const total = map.outputDurationMs;
  return {
    chapters: unique.map((c, i) => ({ ...c, endMs: Math.round(unique[i + 1]?.startMs ?? total) })),
    warnings,
  };
}

function vttTime(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const frac = total % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(frac).padStart(3, "0")}`;
}

export function chaptersToWebVtt(chapters: OutputChapter[]): string {
  const cues = chapters.map(
    (c, i) =>
      `${i + 1}\n${vttTime(c.startMs)} --> ${vttTime(c.endMs)}\n${c.title.replace(/\n/g, " ")}`
  );
  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}

/** FFmpeg metadata file; `-map_chapters` embeds these as MP4 chapters. */
export function chaptersToFfmetadata(chapters: OutputChapter[], title?: string): string {
  const escape = (value: string) => value.replace(/([=;#\\\n])/g, "\\$1");
  const lines = [";FFMETADATA1"];
  if (title) lines.push(`title=${escape(title)}`);
  for (const c of chapters) {
    if (c.endMs <= c.startMs) continue;
    lines.push(
      "",
      "[CHAPTER]",
      "TIMEBASE=1/1000",
      `START=${c.startMs}`,
      `END=${c.endMs}`,
      `title=${escape(c.title)}`
    );
  }
  return `${lines.join("\n")}\n`;
}
