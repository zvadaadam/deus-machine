import { cn } from "@/shared/lib/utils";

export interface BubbleJoins {
  previous?: boolean;
  next?: boolean;
}

export function bubbleClass(side: "user" | "assistant", joins: BubbleJoins) {
  return cn(
    "chat-bubble w-fit max-w-[80%] rounded-xl px-[12px] py-[7px]",
    side === "assistant" && "has-[:is(table,pre,img)]:max-w-full",
    joins.previous && (side === "user" ? "rounded-tr-sm" : "rounded-tl-sm"),
    joins.next && (side === "user" ? "rounded-br-sm" : "rounded-bl-sm")
  );
}
