import { openExternal } from "@/platform/native/window";

const links = {
  ios: ["Install Xcode", "https://apps.apple.com/app/xcode/id497799835"],
  android: [
    "Install Android Studio and create a virtual device",
    "https://developer.android.com/studio",
  ],
} as const;

export function DeviceSetupLink({ platform }: { platform: keyof typeof links }) {
  const [label, url] = links[platform];
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
