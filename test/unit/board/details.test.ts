import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { BoardDetail } from "@shared/boards";
import { BoardDetails } from "../../../apps/web/src/features/board/BoardDetails";

vi.stubGlobal("window", { location: new URL("http://localhost:1420/s/local/b/board-1") });

const board: BoardDetail = {
  id: "board-1",
  name: "Release desk",
  workspace_id: "lead",
  coordinator_name: "Lead",
  last_seq: 4,
  waiting: 0,
  delivery_session_id: "chat-1",
  delivery_title: "Release room",
  delivery_chat: 3,
  delivery_harness: "claude-code",
  read_only: null,
  workspaces: {
    mobile: { name: "Mobile verification", archived: false },
    old: { name: "Old branch", archived: true },
  },
};

function details(changes: Partial<BoardDetail> = {}) {
  const html = renderToStaticMarkup(
    createElement(BoardDetails, { board: { ...board, ...changes } })
  );
  const text = html.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|");
  return { html, text };
}

it("names the coordinator, the chat your messages go to by its tab name, and each workspace", () => {
  const { html, text } = details();
  expect(text).toContain("|# release-desk|");
  expect(text).toContain("|Coordinator|Lead|");
  expect(text).toContain("|Your messages go to|Release room|");
  expect(html).toContain('href="http://localhost:1420/s/local/w/lead?session=chat-1"');
  expect(text).toContain("|Workspaces|Mobile verification|");
  expect(text).toContain("|Old branch|Archived|");
  expect(html).toMatch(/<button type="button" disabled=""[^>]*>.*Old branch/);
  expect(text).not.toContain("Waiting on you");
});

it("names an untitled chat by its agent and number, and leaves the row out without a chat", () => {
  expect(details({ delivery_title: null }).text).toContain("|Your messages go to|Claude Code #3|");
  expect(details({ delivery_session_id: null, delivery_title: null }).text).not.toContain(
    "Your messages go to"
  );
});

it("gives a read-only board's reason in place of the chat", () => {
  const { html, text } = details({ read_only: "archived" });
  expect(text).toContain("The coordinator workspace is archived.");
  expect(text).not.toContain("Your messages go to");
  expect(html).not.toContain("href=");
});

it("counts the questions waiting on you only when there are any", () => {
  expect(details({ waiting: 2 }).text).toContain("|Waiting on you|2 questions|");
  expect(details({ waiting: 1 }).text).toContain("|Waiting on you|1 question|");
  expect(details({ waiting: 0, workspaces: {} }).text).not.toMatch(/Waiting on you|Workspaces/);
});
