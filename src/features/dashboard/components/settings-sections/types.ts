import type { Settings } from '@/types';

export interface SettingsSectionProps {
  settings: Settings;
  setSettings: React.Dispatch<React.SetStateAction<Settings>>;
  saveSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

export interface GeneralSectionProps extends SettingsSectionProps {
  theme: 'light' | 'dark' | 'system';
  setTheme: (theme: 'light' | 'dark' | 'system') => void;
}
