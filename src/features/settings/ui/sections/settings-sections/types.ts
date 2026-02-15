import type { Settings } from "../../../types";

export interface SettingsSectionProps {
  settings: Settings;
  saveSetting: (key: keyof Settings, value: Settings[keyof Settings]) => Promise<boolean>;
}

export interface GeneralSectionProps extends SettingsSectionProps {
  theme: "light" | "dark" | "system";
  setTheme: (theme: "light" | "dark" | "system") => void;
}
