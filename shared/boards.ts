import { z } from "zod";

export const BOARD_PAGE_SIZE = 40;
export const boardPostFields = z.object({
  thread: z.number().int().positive().optional(),
  body: z.string().trim().min(1).max(8000),
});
export type BoardPostInput = z.infer<typeof boardPostFields>;

export const boardReadOnlyReason = { archived: "The coordinator workspace is archived." } as const;

export interface Board {
  id: string;
  name: string;
  workspace_id: string;
  coordinator_name: string;
  delivery_session_id: string | null;
  read_only: keyof typeof boardReadOnlyReason | null;
  last_seq: number;
}

export interface BoardPost {
  id: string;
  seq: number;
  thread_seq: number | null;
  author_kind: "person" | "bot";
  about_workspace_id: string | null;
  body: string;
  created_at: string;
  reply_count: number;
  delivery_session_id: string | null;
  delivery_refusal: string | null;
  delivery_title: string | null;
  delivery_chat: number | null;
  delivery_harness: string | null;
  delivery_hidden: number | null;
}
export interface BoardThread extends BoardPost {
  last_seq: number;
  last_line: string;
  last_reply_at: string | null;
}

export interface BoardChannelPage {
  board: Board;
  posts: BoardThread[];
}
export interface BoardThreadPage {
  root: BoardPost;
  replies: BoardPost[];
  hasEarlier: boolean;
}

export function channelName(name: string) {
  return (
    name
      .trim()
      .replace(/^#+\s*/, "")
      .replace(/\s+/gu, "-")
      .toLowerCase() || name
  );
}
