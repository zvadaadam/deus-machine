import type { Settings } from '@/types';

export interface SettingsSectionProps {
  settings: Settings;
  setSettings: React.Dispatch<React.SetStateAction<Settings>>;
  saveSetting: (key: string, value: any) => void;
}

export interface GeneralSectionProps extends SettingsSectionProps {
  theme: 'light' | 'dark' | 'system';
  setTheme: (theme: 'light' | 'dark' | 'system') => void;
}
