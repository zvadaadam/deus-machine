import type { Meta, StoryObj } from "@storybook/react-vite";
import { PixelGrid, type PixelGridVariant } from "./PixelGrid";

const VARIANTS: { variant: PixelGridVariant; label: string; description: string }[] = [
  { variant: "thinking", label: "Thinking", description: "Extended reasoning — wave columns" },
  { variant: "generating", label: "Generating", description: "Streaming text — random sparkle" },
  {
    variant: "toolExecuting",
    label: "Tool Executing",
    description: "Running bash/edit/read — snake walk",
  },
  { variant: "error", label: "Error", description: "Tool failed — cross pulse" },
  { variant: "compacting", label: "Compacting", description: "Context compaction — slow sparkle" },
];

const meta: Meta<typeof PixelGrid> = {
  title: "Chat/PixelGrid",
  component: PixelGrid,
  argTypes: {
    variant: {
      control: "select",
      options: ["thinking", "generating", "toolExecuting", "error", "compacting"],
    },
    size: { control: { type: "range", min: 12, max: 72, step: 3 } },
    peakOpacity: { control: { type: "range", min: 0.1, max: 1, step: 0.05 } },
    glowBlur: { control: { type: "range", min: 0, max: 20, step: 1 } },
    glowSpread: { control: { type: "range", min: 0, max: 8, step: 0.5 } },
  },
};
export default meta;

/** All 5 variants at default size (24px) on dark background */
export const AllVariants: StoryObj<typeof PixelGrid> = {
  args: {
    size: 18,
    variant: "generating",
    peakOpacity: 0.5,
    glowBlur: 15,
  },

  render: () => (
    <div className="flex flex-col gap-10">
      <h2 className="text-muted-foreground font-mono text-sm tracking-widest uppercase">
        Pixel Grid — Agent Status Indicators
      </h2>
      <div className="grid grid-cols-5 gap-12">
        {VARIANTS.map(({ variant, label, description }) => (
          <div key={variant} className="flex flex-col items-center gap-4">
            <div className="flex items-center justify-center rounded-xl bg-black/80 p-6">
              <PixelGrid variant={variant} size={48} />
            </div>
            <div className="text-center">
              <span className="block font-mono text-xs font-semibold tracking-wide">{label}</span>
              <span className="text-2xs text-muted-foreground mt-1 block">{description}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  ),
};

/** Tune glow with Storybook controls — use the panel on the right */
export const GlowTuner: StoryObj<typeof PixelGrid> = {
  args: {
    variant: "generating",
    size: 48,
    peakOpacity: 0.85,
    glowBlur: 4,
    glowSpread: 1,
  },
  render: (args) => (
    <div className="flex flex-col gap-8">
      <h2 className="text-muted-foreground font-mono text-sm tracking-widest uppercase">
        Glow Tuner — adjust controls in the panel
      </h2>
      <div className="flex items-start gap-12">
        {/* Dark bg */}
        <div className="flex flex-col items-center gap-3">
          <div className="flex items-center justify-center rounded-xl bg-black/90 p-8">
            <PixelGrid {...args} />
          </div>
          <span className="text-2xs text-muted-foreground">Dark bg</span>
        </div>
        {/* Light bg */}
        <div className="flex flex-col items-center gap-3">
          <div className="border-border/40 flex items-center justify-center rounded-xl border bg-white p-8">
            <PixelGrid {...args} />
          </div>
          <span className="text-2xs text-muted-foreground">Light bg</span>
        </div>
        {/* Transparent bg (theme default) */}
        <div className="flex flex-col items-center gap-3">
          <div className="flex items-center justify-center rounded-xl p-8">
            <PixelGrid {...args} />
          </div>
          <span className="text-2xs text-muted-foreground">Theme bg</span>
        </div>
      </div>
      {/* All variants with same tuning */}
      <div className="mt-4 flex gap-10">
        {VARIANTS.map(({ variant, label }) => (
          <div key={variant} className="flex flex-col items-center gap-3">
            <PixelGrid
              variant={variant}
              size={args.size}
              peakOpacity={args.peakOpacity}
              glowBlur={args.glowBlur}
              glowSpread={args.glowSpread}
            />
            <span className="text-2xs text-muted-foreground">{label}</span>
          </div>
        ))}
      </div>
    </div>
  ),
};

/** Size comparison: 18px, 24px, 36px, 48px */
export const Sizes: StoryObj<typeof PixelGrid> = {
  render: () => (
    <div className="flex flex-col gap-8">
      <h2 className="text-muted-foreground font-mono text-sm tracking-widest uppercase">
        Size Comparison
      </h2>
      <div className="flex items-end gap-10">
        {[18, 24, 36, 48].map((size) => (
          <div key={size} className="flex flex-col items-center gap-3">
            <div className="flex items-center justify-center rounded-xl bg-black/80 p-4">
              <PixelGrid variant="generating" size={size} />
            </div>
            <span className="text-muted-foreground font-mono text-xs">{size}px</span>
          </div>
        ))}
      </div>
    </div>
  ),
};

/** How it looks inside the chat — ghost style, no card */
export const InChatIndicator: StoryObj<typeof PixelGrid> = {
  args: {
    glowSpread: 5,
    size: 42,
  },

  render: () => {
    const states: {
      variant: PixelGridVariant;
      label: string;
      timer: string;
      text: string;
    }[] = [
      { variant: "thinking", label: "Thinking", timer: "3.2s", text: "text-primary" },
      { variant: "generating", label: "Generating", timer: "1:23.4", text: "text-success" },
      { variant: "toolExecuting", label: "Tool Executing", timer: "45.1s", text: "text-warning" },
      { variant: "error", label: "Error", timer: "2:01.7", text: "text-destructive" },
      {
        variant: "compacting",
        label: "Compacting",
        timer: "5.0s",
        text: "text-status-compacting",
      },
    ];

    return (
      <div className="flex flex-col gap-8">
        <h2 className="text-muted-foreground font-mono text-sm tracking-widest uppercase">
          In-Chat Working Indicator
        </h2>
        <div className="flex flex-col gap-4">
          {states.map(({ variant, label, timer, text }) => (
            <div key={variant} className="flex items-center gap-4">
              <div className={`flex items-center gap-2 px-2 py-1.5 ${text}`}>
                <PixelGrid variant={variant} size={21} className="flex-shrink-0" />
                <span className="font-mono text-xs tracking-tight tabular-nums opacity-70">
                  {timer}
                </span>
              </div>
              <span className="text-muted-foreground text-xs">{label}</span>
            </div>
          ))}
        </div>
      </div>
    );
  },
};

/** Individual variant stories for focused testing */
export const Thinking: StoryObj<typeof PixelGrid> = {
  args: { variant: "thinking", size: 48 },
  render: (args) => (
    <div className="inline-flex rounded-xl bg-black/80 p-8">
      <PixelGrid {...args} />
    </div>
  ),
};

export const Generating: StoryObj<typeof PixelGrid> = {
  args: { variant: "generating", size: 48 },
  render: (args) => (
    <div className="inline-flex rounded-xl bg-black/80 p-8">
      <PixelGrid {...args} />
    </div>
  ),
};

export const ToolExecuting: StoryObj<typeof PixelGrid> = {
  args: { variant: "toolExecuting", size: 48 },
  render: (args) => (
    <div className="inline-flex rounded-xl bg-black/80 p-8">
      <PixelGrid {...args} />
    </div>
  ),
};

export const Error: StoryObj<typeof PixelGrid> = {
  args: { variant: "error", size: 48 },
  render: (args) => (
    <div className="inline-flex rounded-xl bg-black/80 p-8">
      <PixelGrid {...args} />
    </div>
  ),
};

export const Compacting: StoryObj<typeof PixelGrid> = {
  args: { variant: "compacting", size: 48 },
  render: (args) => (
    <div className="inline-flex rounded-xl bg-black/80 p-8">
      <PixelGrid {...args} />
    </div>
  ),
};
