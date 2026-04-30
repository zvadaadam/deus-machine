import { useMemo } from "react";
import { useFiles } from "@/features/file-browser/api/useFiles";

interface ProjectFileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: ProjectFileNode[];
}

const MOBILE_DIRECTORY_MARKERS = new Set(["android", "ios"]);

const MOBILE_FILE_MARKERS = new Set([
  "podfile",
  "app.config.js",
  "app.config.ts",
  "eas.json",
  "expo-env.d.ts",
  "metro.config.js",
  "metro.config.ts",
  "react-native.config.js",
]);

function hasMobileProjectMarker(files: ProjectFileNode[] | undefined): boolean {
  for (const node of files ?? []) {
    const name = node.name.toLowerCase();
    const pathSegments = node.path.toLowerCase().split("/");

    if (
      MOBILE_FILE_MARKERS.has(name) ||
      name.endsWith(".xcodeproj") ||
      name.endsWith(".xcworkspace") ||
      (node.type === "directory" && MOBILE_DIRECTORY_MARKERS.has(name)) ||
      pathSegments.some((segment) => MOBILE_DIRECTORY_MARKERS.has(segment))
    ) {
      return true;
    }

    if (hasMobileProjectMarker(node.children)) {
      return true;
    }
  }

  return false;
}

export function useWorkspaceIsMobileProject(
  workspaceId: string | null | undefined,
  options?: { enabled?: boolean }
) {
  const files = useFiles(workspaceId ?? null, { enabled: options?.enabled }).data?.files;

  return useMemo(() => hasMobileProjectMarker(files), [files]);
}
