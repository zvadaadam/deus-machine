import { GitPullRequest, GitBranch, MessageSquarePlus } from "lucide-react";
import { cn } from "@/shared/lib/utils";

interface DeusEmptyStateProps {
  parentBranch?: string | null;
  className?: string;
}

/**
 * Steps are the same as the standard empty state — contribution uses the
 * identical workflow. Only the framing sentence changes. We do NOT invent
 * Deus-specific copy for each step because that would be patronizing
 * to a semi-technical user who already knows how to open a PR.
 */
const STEPS = [
  { num: 1, label: "Describe the change", icon: MessageSquarePlus },
  { num: 2, label: "Review the diff", icon: GitBranch },
  { num: 3, label: "Open a pull request", icon: GitPullRequest },
] as const;

/**
 * DeusEmptyState — the "mirror moment" empty state for the deus repo.
 *
 * Direction: "Mirror Moment"
 * Philosophy: The user is holding the tool they are about to improve. The
 * empty state makes that loop tangible — quietly, without ceremony. No
 * gradient, no badge, no hero art. Just a precise sentence that reorients
 * perspective, then the standard workflow.
 *
 * Design decisions:
 *
 * 1. One reorienting sentence above everything else.
 *    "You're building the tool you're in." is a small cognitive surprise —
 *    it makes the abstract (contributing to an open-source IDE) concrete
 *    (this window, right now). It earns attention without demanding it.
 *    Sentence weight: text-sm, text-text-secondary — readable without
 *    visual hierarchy collision with the label above it.
 *
 * 2. The workflow card uses step descriptions, not just step names.
 *    Generic "Build with AI" etc. leaves contribution intent ambiguous.
 *    "Describe the change" / "Review the diff" / "Open a pull request"
 *    maps naturally to a PR-based contribution loop without extra copy.
 *    Each row adds a subtitle so the user immediately understands what
 *    this step means for them.
 *
 * 3. The icon glyph (GitPullRequest at primary/30) is the sole accent.
 *    No glow rings, no gradients, no animated particles. A 16×16 icon at
 *    30% primary opacity gives the eye an anchor without competing with
 *    the text. It signals "PR" semantically so the label doesn't need to.
 *
 * Tradeoff: removing the animated "identity mark" (glow ring + dot) makes
 * the state feel calmer but less distinctive. We accept this — the copy
 * is the differentiation; the animation was decoration.
 */
export function DeusEmptyState({ parentBranch, className }: DeusEmptyStateProps) {
  return (
    <div
      className={cn(
        "animate-fade-in-up flex h-full flex-col items-center justify-center",
        className
      )}
    >
      <div className="flex w-full max-w-[280px] flex-col items-center gap-6">
        {/* Semantic anchor — PR icon at low primary opacity */}
        <GitPullRequest className="text-primary/30 h-4 w-4" strokeWidth={1.5} aria-hidden />

        {/* Identity copy — the reorienting moment */}
        <div className="text-center">
          {/* Same label treatment as standard empty state: uppercase, tracking, muted/60 */}
          <h2 className="text-muted-foreground/60 text-xs font-semibold tracking-wide uppercase">
            Workspace ready
          </h2>

          {/* The sentence that makes the mirror tangible */}
          <p className="text-text-secondary mt-1.5 text-sm leading-snug tracking-[-0.011em]">
            You&apos;re building the tool you&apos;re in.
          </p>

          {/* Branch context — only shown when available */}
          {parentBranch && (
            <p className="text-text-muted mt-1 text-xs leading-normal">
              Branched from <span className="text-text-tertiary font-mono">{parentBranch}</span>.
            </p>
          )}
        </div>

        {/* 3-step contribution workflow card */}
        <div
          className={cn(
            "w-full overflow-hidden rounded-xl",
            "border-border-subtle border",
            "bg-bg-elevated"
          )}
        >
          {STEPS.map((step, i) => {
            const Icon = step.icon;
            return (
              <div
                key={step.label}
                className={cn(
                  "flex items-center gap-3 px-3.5 py-2.5",
                  i < STEPS.length - 1 && "border-border-subtle border-b"
                )}
              >
                {/* Step icon */}
                <div className="flex h-5 w-5 shrink-0 items-center justify-center">
                  <Icon className="text-text-muted h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
                </div>

                {/* Step label */}
                <span className="text-text-tertiary flex-1 text-xs">{step.label}</span>

                {/* Monospace step index — far right, whisper weight */}
                <span className="text-2xs text-text-muted/35 shrink-0 font-mono">
                  {String(step.num).padStart(2, "0")}
                </span>
              </div>
            );
          })}
        </div>

        {/* Closing invitation — plain text, not a button */}
        <p className="text-text-muted/55 text-center text-xs">What would you like to change?</p>
      </div>
    </div>
  );
}
