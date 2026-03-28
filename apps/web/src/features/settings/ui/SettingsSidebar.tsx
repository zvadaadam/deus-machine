import { useEffect, useRef } from "react";
import { ArrowLeft, Settings2, Orbit, Box, FlaskConical, Globe } from "lucide-react";
import { capabilities } from "@/platform";
import type { LucideIcon } from "lucide-react";
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
import type { SettingsSection } from "@shared/types/settings";

interface NavItem {
  id: SettingsSection;
  label: string;
  icon: LucideIcon;
  /** If set, this item only shows when the capability is true. */
  capability?: keyof typeof capabilities;
}

const NAV_ITEMS: NavItem[] = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "ai", label: "AI Providers", icon: Orbit },
  { id: "environment", label: "Environment", icon: Box },
  { id: "experimental", label: "Experimental", icon: FlaskConical },
  { id: "access", label: "Remote Access", icon: Globe },
];

const visibleItems = NAV_ITEMS.filter((item) => !item.capability || capabilities[item.capability]);

export function SettingsSidebar() {
  const closeSettings = useUIStore((s) => s.closeSettings);
  const activeSection = useUIStore((s) => s.activeSettingsSection);
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
                  <span className="text-base">{item.label}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarContent>
    </Sidebar>
  );
}
