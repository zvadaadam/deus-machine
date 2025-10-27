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
 */
export function SidebarSkeleton() {
  return (
    <Sidebar variant="inset" collapsible="icon">
      {/* Header Skeleton */}
      <SidebarHeader className="p-4">
        <div className="flex items-center gap-3">
          <Skeleton className="size-8 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-3 w-32" />
          </div>
        </div>
      </SidebarHeader>

      {/* Content Skeleton - Repository list */}
      <SidebarContent className="group-data-[collapsible=icon]:overflow-visible">
        <SidebarMenu className="p-2 gap-2">
          {/* Render 2-3 repository skeletons */}
          {[1, 2, 3].map((index) => (
            <SidebarMenuItem key={index} className="space-y-2">
              {/* Repository header */}
              <div className="flex items-center gap-2 px-2 py-2">
                <Skeleton className="size-4" />
                <Skeleton className="h-4 flex-1" />
              </div>

              {/* Workspace items (2-4 per repo) */}
              <div className="space-y-1 pl-4">
                {[1, 2].map((wsIndex) => (
                  <div key={wsIndex} className="flex items-center gap-2 px-2 py-2">
                    <Skeleton className="size-3 rounded-sm" />
                    <Skeleton className="h-3 flex-1" />
                  </div>
                ))}
              </div>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarContent>

      {/* Footer Skeleton */}
      <SidebarFooter className="p-4">
        <Skeleton className="h-9 w-full rounded-md" />
      </SidebarFooter>
    </Sidebar>
  );
}
