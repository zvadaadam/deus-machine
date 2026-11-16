/**
 * Tells the person, wherever they are in the app, that an assistant is asking
 * to connect: one toast per request (an assistant removed and asking again is
 * a new request), with Review opening Settings > Remote access. Assistants
 * already waiting when the app opened get no toast (the Settings sidebar marks
 * them), nor do denied ones; a toast goes away once its request is answered,
 * or the person is on the page that lists it.
 */

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { isCloudDirectWebMode } from "@/shared/config/webDirectMode";
import { uiActions, useUIStore } from "@/shared/stores/uiStore";
import { useAssistants } from "../api/assistants.queries";
import { arrivalDescription, createArrivalTracker, requestKey } from "../lib/assistants";

const toastId = (key: string) => `assistant-request-${key}`;

export function useAssistantArrivals() {
  const { data: assistants } = useAssistants(!isCloudDirectWebMode());
  const onAccessPage = useUIStore((s) => s.settingsOpen && s.activeSettingsSection === "access");
  const track = useRef(createArrivalTracker());
  const shown = useRef(new Set<string>());

  useEffect(() => {
    if (!assistants) return;
    const arrived = track.current(assistants);
    if (!onAccessPage) {
      for (const assistant of arrived) {
        const key = requestKey(assistant);
        shown.current.add(key);
        toast(`${assistant.name} wants to connect`, {
          id: toastId(key),
          description: arrivalDescription(assistant),
          duration: Number.POSITIVE_INFINITY,
          action: {
            label: "Review",
            onClick: () => {
              uiActions.openSettings();
              uiActions.setActiveSettingsSection("access");
            },
          },
        });
      }
    }
    // Withdraw a toast whose question was answered, here or on another device.
    const waiting = new Set(assistants.filter((a) => a.access === "pending").map(requestKey));
    for (const key of shown.current) {
      if (onAccessPage || !waiting.has(key)) {
        toast.dismiss(toastId(key));
        shown.current.delete(key);
      }
    }
  }, [assistants, onAccessPage]);
}
