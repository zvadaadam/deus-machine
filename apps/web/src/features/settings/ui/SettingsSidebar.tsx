import { useEffect, useRef } from "react";
import { ArrowLeft } from "lucide-react";
import {
  settingsNavigation,
  isSettingsSectionAvailable,
  resolveSettingsSection,
} from "../settings-navigation";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  useSidebar,
} from "@/components/ui/sidebar";
import { useUIStore } from "@/shared/stores/uiStore";
export function SettingsSidebar() {
  const closeSettings = useUIStore((s) => s.closeSettings);
  const storedSection = useUIStore((s) => s.activeSettingsSection);
  const activeSection = resolveSettingsSection(storedSection).id;
  const visibleItems = settingsNavigation.filter(isSettingsSectionAvailable);
  const setActiveSection = useUIStore((s) => s.setActiveSettingsSection);

  // Settings sidebar must always be visible — force open if the app sidebar was collapsed.
  // Capture prior state so we can restore it when settings closes.
  const { open, setOpen, isMobile, setOpenMobile } = useSidebar();
  const wasOpenOnMount = useRef<boolean | null>(null);

  useEffect(() => {
    if (wasOpenOnMount.current === null) {
      wasOpenOnMount.current = open;
      if (!open) setOpen(true);
    }
  }, [open, setOpen]);

  useEffect(() => {
    return () => {
      if (wasOpenOnMount.current === false) {
        setOpen(false);
      }
    };
  }, [setOpen]);

  return (
    <Sidebar variant="inset" collapsible="offcanvas" className="p-0">
      <SidebarHeader className="px-3.5 py-3">
        <button
          type="button"
          onClick={closeSettings}
          className="text-text-muted hover:text-text-primary flex items-center gap-2 rounded-lg py-0.5 text-sm transition-colors duration-200 ease-out"
        >
          <ArrowLeft className="h-4 w-4 shrink-0" />
          <span>Back to app</span>
        </button>
      </SidebarHeader>

      <SidebarContent className="px-1.5">
        <SidebarMenu className="gap-0.5">
          {visibleItems.map((item) => {
            const isActive = activeSection === item.id;
            const Icon = item.icon;
            return (
              <SidebarMenuItem key={item.id}>
                <SidebarMenuButton
                  isActive={isActive}
                  onClick={() => {
                    setActiveSection(item.id);
                    if (isMobile) setOpenMobile(false);
                  }}
                  className="gap-2.5 px-3 py-1.5"
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="text-base font-medium">{item.label}</span>
                  {item.badge && (
                    <span className="text-text-muted text-xs font-medium">{item.badge}</span>
                  )}
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarContent>
    </Sidebar>
  );
}
