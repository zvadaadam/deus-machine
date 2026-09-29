import { toast } from "sonner";
import { native } from "@/platform";
import { getErrorMessage } from "@shared/lib/errors";
import { resolveProjectFileLink } from "./projectFileLinks";

export function projectMarkdownLinks(
  sourcePath: string,
  availablePaths: readonly string[],
  onOpenFile: (path: string) => void
) {
  return {
    resolveFileLink: (href: string) => resolveProjectFileLink(href, sourcePath, availablePaths),
    onFileLinkOpen: onOpenFile,
    onLinkOpen: (href: string) => {
      const url = href.startsWith("//")
        ? `https:${href}`
        : href.startsWith("www.")
          ? `https://${href}`
          : href;
      return native.window.openExternal(url).catch((error) => {
        toast.error(getErrorMessage(error));
      });
    },
  };
}
