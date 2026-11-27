import { mentionsPerson } from "@shared/board-mentions";

// A character reference such as &#64; renders as a literal character in prose.
export const mentionCandidateSql = "(q.body LIKE '%@you%' OR q.body GLOB '*&*;*')";

// A later post in this thread can only be a reply. The replies index covers the lookup.
export function questionCandidates(scope: string) {
  return `SELECT json_group_array(json_array(q.seq, q.body)) AS candidates FROM board_messages q
    WHERE ${scope} AND q.author_kind = 'bot' AND ${mentionCandidateSql}
    AND NOT EXISTS (SELECT 1 FROM board_messages reply WHERE reply.board_id = q.board_id
      AND reply.thread_seq = COALESCE(q.thread_seq, q.seq) AND reply.seq > q.seq
      AND reply.author_kind = 'person')`;
}

/** Both the sidebar count and the page flags come from this set. */
export function awaitingQuestions(candidates: string) {
  const awaiting = new Set<number>();
  for (const [seq, body] of JSON.parse(candidates) as [number, string][]) {
    if (mentionsPerson(body)) awaiting.add(seq);
  }
  return awaiting;
}
