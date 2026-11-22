import { X } from "lucide-react";

export function MissingAttachments({
  pictures,
  pastedTexts,
  onDismiss,
}: {
  pictures: number;
  pastedTexts: number;
  onDismiss: () => void;
}) {
  if (!pictures && !pastedTexts) return null;
  const kinds = [
    pictures && `${pictures} picture${pictures === 1 ? "" : "s"}`,
    pastedTexts && `${pastedTexts} pasted text${pastedTexts === 1 ? "" : "s"}`,
  ]
    .filter(Boolean)
    .join(" and ");
  return (
    <div className="text-text-muted flex w-full items-center gap-1 px-4 pt-2 text-xs">
      <span>
        {kinds}{" "}
        {pictures + pastedTexts === 1
          ? "was not kept. Add it again."
          : "were not kept. Add them again."}
      </span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss missing attachments"
        className="control-interaction hover:bg-control-hover rounded-sm p-1"
      >
        <X aria-hidden="true" className="size-3" />
      </button>
    </div>
  );
}
