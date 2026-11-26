import { openExternal } from "@/platform/native/window";
import { deviceSetup } from "./devices";

export function DeviceSetupLink({ platform }: { platform: keyof typeof deviceSetup }) {
  const { label, url } = deviceSetup[platform];
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="text-foreground decoration-border-default underline underline-offset-4 hover:decoration-current"
      onClick={(event) => {
        event.preventDefault();
        void openExternal(url);
      }}
    >
      {label}
    </a>
  );
}
