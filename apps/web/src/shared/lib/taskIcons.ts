/**
 * Shared task icon mapping for opendevs.json manifest tasks.
 *
 * Single source of truth used by TaskButton (header) and EnvironmentSection (settings).
 * Keys are the icon names stored in opendevs.json, values are lucide-react components.
 */

import {
  Play,
  Hammer,
  CheckCircle,
  SearchCode,
  Paintbrush,
  Rocket,
  Terminal,
  Package,
  Monitor,
  BookOpen,
  Database,
  Shield,
  RefreshCw,
  Globe,
  Bug,
  Zap,
  FlaskConical,
  type LucideIcon,
} from "lucide-react";

export const TASK_ICON_MAP: Record<string, LucideIcon> = {
  play: Play,
  hammer: Hammer,
  "check-circle": CheckCircle,
  "search-code": SearchCode,
  paintbrush: Paintbrush,
  rocket: Rocket,
  terminal: Terminal,
  package: Package,
  monitor: Monitor,
  "book-open": BookOpen,
  database: Database,
  shield: Shield,
  "refresh-cw": RefreshCw,
  globe: Globe,
  bug: Bug,
  zap: Zap,
  flask: FlaskConical,
};

/** Icon name list for select dropdowns */
export const TASK_ICON_NAMES = Object.keys(TASK_ICON_MAP);

/** Default icon for tasks without an explicit icon */
export const DEFAULT_TASK_ICON = "terminal";
