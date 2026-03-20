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
 * Matches exact spacing from SidebarHeader and SidebarFooter
 */
export function SidebarSkeleton() {
  return (
    <Sidebar
      variant="inset"
      collapsible="offcanvas"
      className="p-0"
      role="status"
      aria-busy="true"
      aria-label="Loading sidebar"
    >
      {/* Header Skeleton - matches SidebarHeader structure */}
      <SidebarHeader className="flex-row items-center justify-between py-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Skeleton className="size-5 flex-shrink-0 rounded-md" />
          <Skeleton className="h-4 w-28" />
        </div>
        <Skeleton className="size-8 rounded-md" />
      </SidebarHeader>

      {/* Content Skeleton - Repository list */}
      <SidebarContent className="scrollbar-hidden">
        <SidebarMenu className="gap-1 px-2 py-2">
          {Array.from({ length: 3 }, (_, index) => (
            <SidebarMenuItem key={index} className="space-y-2">
              {/* Repository header */}
              <div className="flex items-center justify-between gap-2 px-2 py-1.5">
                <div className="flex flex-1 items-center gap-2">
                  <Skeleton className="size-5 flex-shrink-0 rounded-sm" />
                  <Skeleton className="h-4 w-32" />
                </div>
                <div className="flex items-center gap-1">
                  <Skeleton className="size-7 rounded-md" />
                  <Skeleton className="size-7 rounded-md" />
                </div>
              </div>

              {/* Workspace items (2 per repo) */}
              <div className="space-y-2 pl-2">
                {Array.from({ length: 2 }, (_, wsIndex) => (
                  <div key={wsIndex} className="flex items-center gap-3 px-3 py-2">
                    <Skeleton className="size-4 flex-shrink-0 rounded-sm" />
                    <div className="flex flex-1 flex-col gap-1">
                      <Skeleton className="h-3 w-40" />
                      <Skeleton className="h-3 w-32" />
                    </div>
                  </div>
                ))}
              </div>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarContent>

      {/* Footer Skeleton - matches SidebarFooter structure */}
      <SidebarFooter className="border-sidebar-border flex-row items-center border-t">
        <Skeleton className="h-8 flex-1 rounded-md" />
        <Skeleton className="size-8 rounded-md" />
        <Skeleton className="size-8 rounded-md" />
      </SidebarFooter>
    </Sidebar>
  );
}
