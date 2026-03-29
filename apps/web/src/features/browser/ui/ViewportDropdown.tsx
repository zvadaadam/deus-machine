import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { Monitor, Smartphone, Tablet, Check } from "lucide-react";
import type { ViewportState } from "../types";

const DEVICES = [
  { label: "Phone", width: 393, height: 852, dpr: 3, mobile: true },
  { label: "Tablet", width: 820, height: 1180, dpr: 2, mobile: true },
  { label: "Laptop", width: 1440, height: 900, dpr: 2, mobile: false },
  { label: "Desktop", width: 1920, height: 1080, dpr: 1, mobile: false },
] as const;

interface ViewportDropdownProps {
  viewport: ViewportState | null;
  onChange: (viewport: ViewportState | null) => void;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
}

function matchDevice(vp: ViewportState | null) {
  if (!vp) return null;
  return DEVICES.find((d) => d.width === vp.width && d.height === vp.height) ?? null;
}

function deviceIcon(d: { mobile: boolean; width: number } | null) {
  if (!d) return Monitor;
  if (d.mobile && d.width < 500) return Smartphone;
  if (d.mobile) return Tablet;
  return Monitor;
}

export function ViewportDropdown({ viewport, onChange, onOpenChange, disabled }: ViewportDropdownProps) {
  const [customOpen, setCustomOpen] = useState(false);
  const [customW, setCustomW] = useState("1280");
  const [customH, setCustomH] = useState("720");

  const Icon = deviceIcon(matchDevice(viewport) ?? (viewport ? { mobile: viewport.width < 768, width: viewport.width } : null));
  const isResponsive = viewport === null;

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        onOpenChange?.(open);
        if (!open) setCustomOpen(false);
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          disabled={disabled}
          title={viewport ? `${viewport.width} x ${viewport.height}` : "Responsive"}
          aria-label="Viewport size"
        >
          <Icon className={`h-4 w-4 ${!isResponsive ? "text-primary" : ""}`} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem onSelect={() => onChange(null)}>
          <Monitor className="mr-2 h-3.5 w-3.5" />
          Responsive
          {isResponsive && <Check className="ml-auto h-3.5 w-3.5" />}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
          Devices
        </DropdownMenuLabel>
        {DEVICES.map((device) => {
          const active = viewport?.width === device.width && viewport?.height === device.height;
          const DeviceIcon = deviceIcon(device);
          return (
            <DropdownMenuItem
              key={device.label}
              onSelect={() =>
                onChange({ width: device.width, height: device.height, deviceScaleFactor: device.dpr })
              }
            >
              <DeviceIcon className="mr-2 h-3.5 w-3.5" />
              {device.label}
              <span className="text-muted-foreground ml-auto text-xs">
                {device.width}x{device.height}
              </span>
              {active && <Check className="ml-1.5 h-3.5 w-3.5" />}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        {customOpen ? (
          <div className="flex items-center gap-1.5 px-2 py-1.5">
            <Input
              className="h-6 w-16 px-1.5 text-xs"
              value={customW}
              onChange={(e) => setCustomW(e.target.value)}
              placeholder="W"
              type="number"
            />
            <span className="text-muted-foreground text-xs">x</span>
            <Input
              className="h-6 w-16 px-1.5 text-xs"
              value={customH}
              onChange={(e) => setCustomH(e.target.value)}
              placeholder="H"
              type="number"
            />
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => {
                const w = parseInt(customW, 10);
                const h = parseInt(customH, 10);
                if (w >= 320 && h >= 240) {
                  onChange({ width: w, height: h, deviceScaleFactor: 1 });
                }
              }}
            >
              Apply
            </Button>
          </div>
        ) : (
          <DropdownMenuItem onSelect={(e) => { e.preventDefault(); setCustomOpen(true); }}>
            Custom...
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
