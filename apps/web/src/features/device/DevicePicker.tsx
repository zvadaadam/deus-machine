import { ChevronDown, ExternalLink } from "lucide-react";
import type { HubDevice, HubInventory } from "@shared/types/device-hub";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { deviceKey, deviceSetup } from "./devices";

function DeviceGroup({
  platform,
  inventory,
}: {
  platform: HubDevice["platform"];
  inventory: HubInventory;
}) {
  const label = platform === "ios" ? "iOS Simulators" : "Android emulators";
  const devices = inventory.devices.filter((device) => device.platform === platform);
  const setup = deviceSetup[platform];
  return (
    <DropdownMenuGroup aria-label={label}>
      <DropdownMenuLabel className="bg-popover text-muted-foreground sticky top-0 z-10 text-xs">
        {label}
      </DropdownMenuLabel>
      {devices.map((device) => (
        <DropdownMenuRadioItem key={device.id} value={deviceKey(device)}>
          {device.name} · {device.version}
        </DropdownMenuRadioItem>
      ))}
      {!devices.length &&
        (inventory.available[platform] ? (
          <DropdownMenuItem disabled>{setup.create}</DropdownMenuItem>
        ) : (
          <DropdownMenuItem asChild>
            <a href={setup.url} target="_blank" rel="noreferrer">
              {setup.label} <ExternalLink />
            </a>
          </DropdownMenuItem>
        ))}
    </DropdownMenuGroup>
  );
}

export function DevicePicker({
  inventory,
  selected,
  disabled,
  onOpen,
  onSelect,
}: {
  inventory?: HubInventory;
  selected?: HubDevice;
  disabled: boolean;
  onOpen: () => void;
  onSelect: (key: string) => void;
}) {
  const placeholder = inventory ? "Choose a device" : "Finding devices…";
  return (
    <DropdownMenu onOpenChange={(open) => open && onOpen()}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label="Choose device"
          aria-description={selected?.name}
          disabled={disabled || !inventory}
          className="min-w-0 shrink justify-between"
        >
          <span className="truncate">
            {selected ? `${selected.name} · ${selected.version}` : placeholder}
          </span>
          <ChevronDown className="text-muted-foreground size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      {inventory && (
        <DropdownMenuContent
          align="start"
          className="flex max-h-[min(26rem,var(--radix-dropdown-menu-content-available-height))] max-w-[min(24rem,95vw)] flex-col overflow-hidden"
        >
          <DropdownMenuRadioGroup
            className="min-h-0 overflow-y-auto overscroll-contain"
            value={selected && deviceKey(selected)}
            onValueChange={onSelect}
          >
            <DeviceGroup platform="ios" inventory={inventory} />
            {inventory.available.android && (
              <DeviceGroup platform="android" inventory={inventory} />
            )}
          </DropdownMenuRadioGroup>
          {!inventory.available.android && (
            <>
              <DropdownMenuSeparator className="shrink-0" />
              <DropdownMenuItem asChild>
                <a href={deviceSetup.android.url} target="_blank" rel="noreferrer">
                  Android emulators need Android Studio <ExternalLink />
                </a>
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      )}
    </DropdownMenu>
  );
}
