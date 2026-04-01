import { FolderGit2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  icon: LucideIcon;
  type: "empty" | "github";
  url?: string;
}

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    id: "empty",
    name: "Empty Project",
    description: "Blank repository with a README",
    icon: FolderGit2,
    type: "empty",
  },
  // More templates can be added here (type: "github" with a URL to clone from)
];
