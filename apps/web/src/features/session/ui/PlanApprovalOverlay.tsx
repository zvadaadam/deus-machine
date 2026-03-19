// src/features/session/ui/PlanApprovalOverlay.tsx
//
// Renders the plan approval UI when the agent calls ExitPlanMode.
//
// The plan content itself is already visible in the chat as regular assistant messages —
// the agent writes a plan in text before calling ExitPlanMode. This overlay only adds
// the Approve / Reject action buttons.
//
// Design rationale:
// - Rendered inline at the bottom of Chat (above MessageInput), not as a modal.
//   This preserves context — the user can scroll up to re-read the plan.
// - AnimatePresence handles mount/unmount transitions (Framer Motion per CLAUDE.md).
// - Clicking Reject sends { approved: false } immediately without asking the user
//   to type a reason — that explanation flows in the next user message naturally.

import { AnimatePresence, motion } from "framer-motion";
import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getAgentLogo } from "@/assets/agents";
import type { PlanModeRequest } from "../hooks/useAgentRpcHandler";

interface PlanApprovalOverlayProps {
  request: PlanModeRequest | null;
  agentType?: string;
  onApprove: () => void;
  onReject: () => void;
}

export function PlanApprovalOverlay({
  request,
  agentType,
  onApprove,
  onReject,
}: PlanApprovalOverlayProps) {
  return (
    <AnimatePresence>
      {request && (
        <motion.div
          key="plan-approval"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 6 }}
          transition={{ duration: 0.2, ease: [0.165, 0.84, 0.44, 1] }}
          className="border-border/50 bg-muted/30 mx-4 mb-3 flex items-center gap-3 rounded-xl border px-4 py-3 backdrop-blur-sm"
          role="dialog"
          aria-label="Plan approval"
          aria-live="polite"
        >
          {(() => {
            const Logo = getAgentLogo(agentType || "claude");
            return Logo ? <Logo className="h-5 w-5 shrink-0" aria-hidden="true" /> : null;
          })()}

          <div className="min-w-0 flex-1">
            <p className="text-foreground text-sm font-medium">
              Agent is ready to execute the plan
            </p>
            <p className="text-muted-foreground mt-0.5 text-xs">
              Review the plan above, then approve or reject.
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              onClick={onReject}
              aria-label="Reject plan"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              Reject
            </Button>
            <Button
              size="sm"
              className="h-8 gap-1.5 text-xs"
              onClick={onApprove}
              aria-label="Approve plan"
            >
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
              Approve
            </Button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
