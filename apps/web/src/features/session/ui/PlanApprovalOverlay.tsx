// Plan approval overlay — inline at bottom of Chat (above MessageInput).
// Only shows Approve / Reject buttons. Plan content is rendered inline
// in the chat via ExitPlanModeToolRenderer.

import { AnimatePresence, motion } from "framer-motion";
import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getAgentLogo } from "@/assets/agents";
import type { PlanModeRequest } from "../hooks/useAgentRpcHandler";

interface PlanApprovalOverlayProps {
  request: PlanModeRequest | null;
  agentHarness?: string;
  onApprove: () => void;
  onReject: () => void;
}

export function PlanApprovalOverlay({
  request,
  agentHarness,
  onApprove,
  onReject,
}: PlanApprovalOverlayProps) {
  const Logo = getAgentLogo(agentHarness || "claude");

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
          {/* eslint-disable-next-line react-hooks/static-components */}
          {Logo && <Logo className="h-5 w-5 shrink-0" aria-hidden="true" />}

          <p className="text-foreground min-w-0 flex-1 text-sm font-medium">
            Agent is ready to execute the plan
          </p>

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
