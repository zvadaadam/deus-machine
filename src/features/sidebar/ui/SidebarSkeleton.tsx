import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * SidebarSkeleton - Loading state for the AppSidebar
 * Maintains the same width and structure as AppSidebar to prevent layout shifts
 * Matches exact spacing from SidebarHeader (p-2) and SidebarFooter (p-2 pt-0)
 */
export function SidebarSkeleton() {
  return (
    <Sidebar variant="inset" collapsible="icon" role="status" aria-busy="true" aria-label="Loading sidebar">
      {/* Header Skeleton - matches SidebarHeader structure */}
      <SidebarHeader className="p-2">
        <div className="flex items-center gap-3 p-2 rounded-lg">
          <Skeleton className="size-8 rounded-full flex-shrink-0" />
          <Skeleton className="h-4 flex-1" />
        </div>
      </SidebarHeader>

      {/* Content Skeleton - Repository list */}
      <SidebarContent className="group-data-[collapsible=icon]:overflow-visible">
        <SidebarMenu className="p-2 gap-2">
          {Array.from({ length: 3 }, (_, index) => (
            <SidebarMenuItem key={index} className="space-y-2">
              {/* Repository header */}
              <div className="flex items-center gap-2 px-2 py-2">
                <Skeleton className="size-4 flex-shrink-0" />
                <Skeleton className="h-4 flex-1" />
              </div>

              {/* Workspace items (2 per repo) */}
              <div className="space-y-1 pl-4">
                {Array.from({ length: 2 }, (_, wsIndex) => (
                  <div key={wsIndex} className="flex items-center gap-2 px-2 py-2">
                    <Skeleton className="size-3 rounded-sm flex-shrink-0" />
                    <Skeleton className="h-3 flex-1" />
                  </div>
                ))}
              </div>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarContent>

      {/* Footer Skeleton - matches SidebarFooter structure */}
      <SidebarFooter className="p-2 pt-0">
        <Skeleton className="h-8 w-full rounded-md" />
      </SidebarFooter>
    </Sidebar>
  );
}
