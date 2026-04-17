// src/features/session/ui/AgentQuestionOverlay.tsx
//
// Renders structured questions from the agent (askUserQuestion RPC method).
//
// Each question can have:
//   - options: string[]          → render as clickable chips/pills
//   - multiSelect?: boolean      → allow multiple selections before submitting
//
// UX decisions:
//   - Single-select: clicking an option immediately submits that question's answer
//     and advances to the next question (or submits all if it's the last one).
//   - Multi-select: selections toggle, a "Done" button submits.
//   - "Other..." chip: expands an inline text input for custom answers. For single-select,
//     pressing Enter submits the custom text. For multi-select, the text is added to selections.
//   - All questions are answered before the response is sent (batch, not streaming).
//   - The overlay appears inline above MessageInput, same position as PlanApprovalOverlay.

import { useState, useCallback, useMemo, useRef } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Check, ChevronRight, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/shared/lib/utils";
import { getAgentLogo } from "@/assets/agents";
import type { AskQuestionRequest } from "../hooks/useAgentRpcHandler";

interface AgentQuestionOverlayProps {
  request: AskQuestionRequest | null;
  agentHarness?: string;
  onSubmit: (answers: (string | string[])[]) => void;
  onDismiss: () => void;
}

export function AgentQuestionOverlay({
  request,
  agentHarness,
  onSubmit,
  onDismiss,
}: AgentQuestionOverlayProps) {
  const reduceMotion = useReducedMotion();

  // Track answers per question index
  const [answers, setAnswers] = useState<(string | string[] | null)[]>([]);
  // Track which question the user is currently answering
  const [currentIndex, setCurrentIndex] = useState(0);
  // Track "Other" input visibility and value per question
  const [showOtherInput, setShowOtherInput] = useState<Record<number, boolean>>({});
  const [otherText, setOtherText] = useState<Record<number, string>>({});
  const otherInputRef = useRef<HTMLInputElement>(null);

  const questions = useMemo(() => request?.questions ?? [], [request?.questions]);

  const handleOptionClick = useCallback(
    (questionIndex: number, option: string) => {
      const question = questions[questionIndex];
      if (!question) return;

      // Close "Other" input when clicking a predefined option
      setShowOtherInput((prev) => ({ ...prev, [questionIndex]: false }));

      if (question.multiSelect) {
        // Toggle selection in multi-select mode
        setAnswers((prev) => {
          const next = [...prev];
          const current = (next[questionIndex] as string[] | undefined) ?? [];
          if (current.includes(option)) {
            next[questionIndex] = current.filter((o) => o !== option);
          } else {
            next[questionIndex] = [...current, option];
          }
          return next;
        });
      } else {
        // Single-select: record answer and advance
        const newAnswers = [...answers];
        newAnswers[questionIndex] = option;
        setAnswers(newAnswers);

        if (questionIndex < questions.length - 1) {
          // More questions to answer
          setCurrentIndex(questionIndex + 1);
        } else {
          // All answered — submit
          const finalAnswers = newAnswers.map((a) => a ?? "");
          onSubmit(finalAnswers as (string | string[])[]);
        }
      }
    },
    [questions, answers, onSubmit]
  );

  const handleOtherClick = useCallback((questionIndex: number) => {
    setShowOtherInput((prev) => {
      const isShowing = !prev[questionIndex];
      if (isShowing) {
        // Focus the input after it renders
        setTimeout(() => otherInputRef.current?.focus(), 0);
      }
      return { ...prev, [questionIndex]: isShowing };
    });
  }, []);

  const handleOtherSubmit = useCallback(
    (questionIndex: number) => {
      const text = otherText[questionIndex]?.trim();
      if (!text) return;

      const question = questions[questionIndex];
      if (!question) return;

      if (question.multiSelect) {
        // Add custom text to multi-select answers
        setAnswers((prev) => {
          const next = [...prev];
          const current = (next[questionIndex] as string[] | undefined) ?? [];
          if (!current.includes(text)) {
            next[questionIndex] = [...current, text];
          }
          return next;
        });
        // Clear input but keep it open for more custom entries
        setOtherText((prev) => ({ ...prev, [questionIndex]: "" }));
      } else {
        // Single-select: submit custom text as the answer
        const newAnswers = [...answers];
        newAnswers[questionIndex] = text;
        setAnswers(newAnswers);

        if (questionIndex < questions.length - 1) {
          setCurrentIndex(questionIndex + 1);
          setShowOtherInput((prev) => ({ ...prev, [questionIndex]: false }));
        } else {
          const finalAnswers = newAnswers.map((a) => a ?? "");
          onSubmit(finalAnswers as (string | string[])[]);
        }
      }
    },
    [otherText, questions, answers, onSubmit]
  );

  const handleMultiSelectDone = useCallback(
    (questionIndex: number) => {
      // Include custom text if the input is open and has content
      const customText = otherText[questionIndex]?.trim();
      if (customText) {
        setAnswers((prev) => {
          const next = [...prev];
          const current = (next[questionIndex] as string[] | undefined) ?? [];
          if (!current.includes(customText)) {
            next[questionIndex] = [...current, customText];
          }
          return next;
        });
      }

      const current = (answers[questionIndex] as string[] | undefined) ?? [];
      const totalSelections =
        current.length + (customText && !current.includes(customText) ? 1 : 0);
      if (totalSelections === 0) return; // Require at least one selection

      if (questionIndex < questions.length - 1) {
        setCurrentIndex(questionIndex + 1);
        setShowOtherInput((prev) => ({ ...prev, [questionIndex]: false }));
      } else {
        // Build final answers with the custom text included
        const finalAnswers = answers.map((a, i) => {
          if (i === questionIndex && customText) {
            const arr = (a as string[] | undefined) ?? [];
            return arr.includes(customText) ? arr : [...arr, customText];
          }
          return a ?? "";
        });
        onSubmit(finalAnswers as (string | string[])[]);
      }
    },
    [answers, otherText, questions.length, onSubmit]
  );

  const currentQuestion = questions[currentIndex];

  const isOtherOpen = showOtherInput[currentIndex] ?? false;

  return (
    <AnimatePresence>
      {request && currentQuestion && (
        <motion.div
          key={`agent-question-${request.wsRequestId}-${currentIndex}`}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 6 }}
          transition={{ duration: 0.2, ease: [0.165, 0.84, 0.44, 1] }}
          className="border-border/50 bg-muted/30 mx-4 mb-3 rounded-xl border px-4 py-3 backdrop-blur-sm"
          role="dialog"
          aria-label="Agent question"
          aria-live="polite"
        >
          {/* Progress indicator for multi-question flows */}
          {questions.length > 1 && (
            <div className="mb-2 flex items-center gap-1.5">
              {questions.map((_, i) => (
                <span
                  key={i}
                  className={cn(
                    "h-1 w-6 origin-left rounded-full transition-transform duration-200",
                    i < currentIndex
                      ? "bg-primary scale-x-[0.667]"
                      : i === currentIndex
                        ? "bg-primary scale-x-100"
                        : "bg-border scale-x-[0.333]"
                  )}
                  aria-hidden="true"
                />
              ))}
              <span className="text-muted-foreground ml-1 text-xs">
                {currentIndex + 1} / {questions.length}
              </span>
            </div>
          )}

          {/* Question text with agent logo */}
          <div className="mb-3 flex items-start gap-2.5">
            {(() => {
              const Logo = getAgentLogo(agentHarness || "claude");
              return Logo ? <Logo className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> : null;
            })()}
            <p className="text-foreground min-w-0 text-sm font-medium">
              {currentQuestion.question}
            </p>
          </div>

          {/* Option chips */}
          <div className="flex flex-wrap gap-2" role="group" aria-label="Answer options">
            {currentQuestion.options.map((option) => {
              const multiAnswers = (answers[currentIndex] as string[] | undefined) ?? [];
              const isSelected = currentQuestion.multiSelect
                ? multiAnswers.includes(option)
                : answers[currentIndex] === option;

              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => handleOptionClick(currentIndex, option)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium",
                    "ease transition-colors duration-150",
                    "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
                    isSelected
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground"
                  )}
                  aria-pressed={currentQuestion.multiSelect ? isSelected : undefined}
                  aria-label={option}
                >
                  {currentQuestion.multiSelect && isSelected && (
                    <Check className="h-3 w-3 shrink-0" aria-hidden="true" />
                  )}
                  {option}
                </button>
              );
            })}

            {/* "Other..." chip — opens inline text input */}
            <button
              type="button"
              onClick={() => handleOtherClick(currentIndex)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium",
                "ease transition-colors duration-150",
                "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
                isOtherOpen
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground border-dashed"
              )}
              aria-label="Type a custom answer"
            >
              <Pencil className="h-3 w-3 shrink-0" aria-hidden="true" />
              Other...
            </button>
          </div>

          {/* Inline text input for custom answers — Enter to submit */}
          <AnimatePresence>
            {isOtherOpen && (
              <motion.div
                initial={reduceMotion ? false : { opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
                transition={{ duration: 0.15, ease: [0.165, 0.84, 0.44, 1] }}
                className="overflow-hidden"
              >
                <input
                  ref={otherInputRef}
                  type="text"
                  value={otherText[currentIndex] ?? ""}
                  onChange={(e) =>
                    setOtherText((prev) => ({ ...prev, [currentIndex]: e.target.value }))
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleOtherSubmit(currentIndex);
                    }
                    if (e.key === "Escape") {
                      setShowOtherInput((prev) => ({ ...prev, [currentIndex]: false }));
                    }
                  }}
                  placeholder="Type your answer and press Enter..."
                  className={cn(
                    "text-foreground placeholder:text-muted-foreground/60",
                    "mt-2 w-full border-0 bg-transparent px-0 py-1 text-xs",
                    "border-border/50 border-b",
                    "focus:border-primary focus:outline-none"
                  )}
                  aria-label="Custom answer"
                />
              </motion.div>
            )}
          </AnimatePresence>

          {/* Footer: multi-select shows helper text + Done/Skip, single-select shows Skip only */}
          {currentQuestion.multiSelect ? (
            <div className="mt-3 flex items-center justify-between">
              <span className="text-muted-foreground text-xs">Select all that apply</span>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onDismiss}>
                  Skip
                </Button>
                <Button
                  size="sm"
                  className="h-7 gap-1 text-xs"
                  disabled={((answers[currentIndex] as string[]) ?? []).length === 0}
                  onClick={() => handleMultiSelectDone(currentIndex)}
                >
                  {currentIndex < questions.length - 1 ? (
                    <>
                      Next
                      <ChevronRight className="h-3 w-3" aria-hidden="true" />
                    </>
                  ) : (
                    "Submit"
                  )}
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-3 flex justify-end">
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onDismiss}>
                Skip
              </Button>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
