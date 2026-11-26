import { z } from "zod";

const lineBreak = /[\n\r\v\f\u0085\u2028\u2029]/u;
const maxLength = 120;

export const TitleSchema = z
  .string()
  .refine((text) => !lineBreak.test(text), "Use one line")
  .trim()
  .min(1, "Give the chat or workspace a name")
  .refine((text) => [...text].length <= maxLength, `Use at most ${maxLength} characters`);

export function toTitle(text: string): string | null {
  const first = text.split(lineBreak, 1)[0]!.trim();
  return [...first].slice(0, maxLength).join("").trimEnd() || null;
}
