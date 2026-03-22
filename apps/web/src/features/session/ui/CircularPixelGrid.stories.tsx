import type { Meta, StoryObj } from "@storybook/react-vite";
import { CircularPixelGrid, type CircularPixelGridVariant } from "./CircularPixelGrid";
import { PixelGrid } from "./PixelGrid";

const VARIANTS: { variant: CircularPixelGridVariant; label: string; color: string }[] = [
  { variant: "thinking", label: "Thinking", color: "text-[oklch(0.68_0.14_265)]" },
  { variant: "generating", label: "Generating", color: "text-success" },
  { variant: "toolExecuting", label: "Tool Executing", color: "text-warning" },
  { variant: "error", label: "Error", color: "text-destructive" },
  { variant: "compacting", label: "Compacting", color: "text-[oklch(0.68_0.14_300)]" },
  { variant: "working", label: "Working", color: "text-muted-foreground" },
];

const meta: Meta<typeof CircularPixelGrid> = {
  title: "Chat/CircularPixelGrid",
  component: CircularPixelGrid,
  argTypes: {
    variant: {
      control: "select",
      options: ["thinking", "generating", "toolExecuting", "error", "compacting", "working"],
    },
    size: { control: { type: "range", min: 12, max: 96, step: 2 } },
    resolution: { control: { type: "range", min: 6, max: 32, step: 1 } },
    gap: { control: { type: "range", min: 0, max: 0.5, step: 0.05 } },
    dotShape: { control: "select", options: ["square", "round"] },
  },
};
export default meta;

/* ── All 6 Variants ──────────────────────────────────────── */

export const AllVariants: StoryObj<typeof CircularPixelGrid> = {
  render: () => (
    <div className="flex flex-col gap-10">
      <h2 className="text-muted-foreground font-mono text-sm tracking-widest uppercase">
        Circular Pixel Grid — All Variants (48px, res 16)
      </h2>
      <div className="grid grid-cols-6 gap-12">
        {VARIANTS.map(({ variant, label }) => (
          <div key={variant} className="flex flex-col items-center gap-4">
            <div className="flex items-center justify-center rounded-xl bg-black/80 p-8">
              <CircularPixelGrid variant={variant} size={48} resolution={16} />
            </div>
            <span className="text-muted-foreground font-mono text-xs">{label}</span>
          </div>
        ))}
      </div>
    </div>
  ),
};

/* ── Resolution Comparison ───────────────────────────────── */

export const ResolutionComparison: StoryObj<typeof CircularPixelGrid> = {
  render: () => {
    const resolutions = [8, 12, 16, 20, 24, 32];
    return (
      <div className="flex flex-col gap-10">
        <h2 className="text-muted-foreground font-mono text-sm tracking-widest uppercase">
          Resolution Comparison — "thinking" at 60px
        </h2>
        <div className="flex items-end gap-8">
          {resolutions.map((res) => (
            <div key={res} className="flex flex-col items-center gap-3">
              <div className="flex items-center justify-center rounded-xl bg-black/80 p-6">
                <CircularPixelGrid variant="thinking" size={60} resolution={res} />
              </div>
              <span className="text-muted-foreground font-mono text-xs">
                {res}×{res}
              </span>
            </div>
          ))}
        </div>

        <h2 className="text-muted-foreground mt-8 font-mono text-sm tracking-widest uppercase">
          Resolution Comparison — "generating" at 60px
        </h2>
        <div className="flex items-end gap-8">
          {resolutions.map((res) => (
            <div key={res} className="flex flex-col items-center gap-3">
              <div className="flex items-center justify-center rounded-xl bg-black/80 p-6">
                <CircularPixelGrid variant="generating" size={60} resolution={res} />
              </div>
              <span className="text-muted-foreground font-mono text-xs">
                {res}×{res}
              </span>
            </div>
          ))}
        </div>

        <h2 className="text-muted-foreground mt-8 font-mono text-sm tracking-widest uppercase">
          Resolution Comparison — "toolExecuting" at 60px
        </h2>
        <div className="flex items-end gap-8">
          {resolutions.map((res) => (
            <div key={res} className="flex flex-col items-center gap-3">
              <div className="flex items-center justify-center rounded-xl bg-black/80 p-6">
                <CircularPixelGrid variant="toolExecuting" size={60} resolution={res} />
              </div>
              <span className="text-muted-foreground font-mono text-xs">
                {res}×{res}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  },
};

/* ── Dot Shape: Square vs Round ──────────────────────────── */

export const DotShapeComparison: StoryObj<typeof CircularPixelGrid> = {
  render: () => (
    <div className="flex flex-col gap-10">
      <h2 className="text-muted-foreground font-mono text-sm tracking-widest uppercase">
        Dot Shape — Square vs Round (60px, res 16)
      </h2>
      <div className="grid grid-cols-5 gap-8">
        {VARIANTS.map(({ variant, label }) => (
          <div key={variant} className="flex flex-col items-center gap-4">
            <div className="flex items-center gap-6 rounded-xl bg-black/80 p-6">
              <div className="flex flex-col items-center gap-2">
                <CircularPixelGrid variant={variant} size={60} dotShape="square" />
                <span className="text-muted-foreground text-[10px]">square</span>
              </div>
              <div className="flex flex-col items-center gap-2">
                <CircularPixelGrid variant={variant} size={60} dotShape="round" />
                <span className="text-muted-foreground text-[10px]">round</span>
              </div>
            </div>
            <span className="text-muted-foreground font-mono text-xs">{label}</span>
          </div>
        ))}
      </div>
    </div>
  ),
};

/* ── Size Comparison ─────────────────────────────────────── */

export const SizeComparison: StoryObj<typeof CircularPixelGrid> = {
  render: () => {
    const sizes = [14, 18, 24, 36, 48, 72];
    return (
      <div className="flex flex-col gap-10">
        <h2 className="text-muted-foreground font-mono text-sm tracking-widest uppercase">
          Size Comparison — "generating", res 16
        </h2>
        <div className="flex items-end gap-8">
          {sizes.map((s) => (
            <div key={s} className="flex flex-col items-center gap-3">
              <div className="flex items-center justify-center rounded-xl bg-black/80 p-6">
                <CircularPixelGrid variant="generating" size={s} resolution={16} />
              </div>
              <span className="text-muted-foreground font-mono text-xs">{s}px</span>
            </div>
          ))}
        </div>

        <h2 className="text-muted-foreground mt-4 font-mono text-sm tracking-widest uppercase">
          Small sizes — adaptive resolution (res 10)
        </h2>
        <div className="flex items-end gap-8">
          {sizes.map((s) => (
            <div key={s} className="flex flex-col items-center gap-3">
              <div className="flex items-center justify-center rounded-xl bg-black/80 p-6">
                <CircularPixelGrid variant="generating" size={s} resolution={10} />
              </div>
              <span className="text-muted-foreground font-mono text-xs">{s}px / r10</span>
            </div>
          ))}
        </div>
      </div>
    );
  },
};

/* ── Old vs New: Side by Side ────────────────────────────── */

export const OldVsNew: StoryObj<typeof CircularPixelGrid> = {
  render: () => (
    <div className="flex flex-col gap-10">
      <h2 className="text-muted-foreground font-mono text-sm tracking-widest uppercase">
        Old (3×3 Square) vs New (Circular) — 48px
      </h2>
      <div className="grid grid-cols-5 gap-8">
        {VARIANTS.map(({ variant, label }) => (
          <div key={variant} className="flex flex-col items-center gap-4">
            <div className="flex items-center gap-8 rounded-xl bg-black/80 p-6">
              <div className="flex flex-col items-center gap-2">
                <PixelGrid variant={variant} size={48} />
                <span className="text-muted-foreground text-[10px]">3×3</span>
              </div>
              <div className="flex flex-col items-center gap-2">
                <CircularPixelGrid variant={variant} size={48} resolution={16} />
                <span className="text-muted-foreground text-[10px]">circular</span>
              </div>
            </div>
            <span className="text-muted-foreground font-mono text-xs">{label}</span>
          </div>
        ))}
      </div>

      <h2 className="text-muted-foreground mt-6 font-mono text-sm tracking-widest uppercase">
        Inline size (15px) — as used in chat indicator
      </h2>
      <div className="flex gap-8">
        {VARIANTS.map(({ variant, label, color }) => (
          <div key={variant} className="flex flex-col items-center gap-3">
            <div className={`flex items-center gap-3 ${color}`}>
              <div className="flex flex-col items-center gap-1">
                <PixelGrid variant={variant} size={15} />
                <span className="text-muted-foreground text-[9px]">old</span>
              </div>
              <div className="flex flex-col items-center gap-1">
                <CircularPixelGrid variant={variant} size={15} resolution={10} />
                <span className="text-muted-foreground text-[9px]">new</span>
              </div>
            </div>
            <span className="text-muted-foreground text-[10px]">{label}</span>
          </div>
        ))}
      </div>
    </div>
  ),
};

/* ── In-Chat Indicator Preview ───────────────────────────── */

export const InChatIndicator: StoryObj<typeof CircularPixelGrid> = {
  render: () => {
    const states = [
      { variant: "thinking" as const, label: "Thinking", timer: "3.2s", color: "text-primary" },
      {
        variant: "generating" as const,
        label: "Generating",
        timer: "1:23.4",
        color: "text-success",
      },
      {
        variant: "toolExecuting" as const,
        label: "Tool Executing",
        timer: "45.1s",
        color: "text-warning",
      },
      { variant: "error" as const, label: "Error", timer: "2:01.7", color: "text-destructive" },
      {
        variant: "compacting" as const,
        label: "Compacting",
        timer: "5.0s",
        color: "text-status-compacting",
      },
    ];

    return (
      <div className="flex flex-col gap-8">
        <h2 className="text-muted-foreground font-mono text-sm tracking-widest uppercase">
          In-Chat Working Indicator (circular)
        </h2>
        <div className="flex flex-col gap-4">
          {states.map(({ variant, label, timer, color }) => (
            <div key={variant} className="flex items-center gap-4">
              <div className={`flex items-center gap-2 px-2 py-1.5 ${color}`}>
                <CircularPixelGrid
                  variant={variant}
                  size={21}
                  resolution={12}
                  className="flex-shrink-0"
                />
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

/* ── Large Display: Hero Size ────────────────────────────── */

export const HeroSize: StoryObj<typeof CircularPixelGrid> = {
  render: () => (
    <div className="flex flex-col gap-10">
      <h2 className="text-muted-foreground font-mono text-sm tracking-widest uppercase">
        Hero Size — 96px, res 24
      </h2>
      <div className="flex gap-12">
        {VARIANTS.map(({ variant, label }) => (
          <div key={variant} className="flex flex-col items-center gap-4">
            <div className="flex items-center justify-center rounded-2xl bg-black/90 p-10">
              <CircularPixelGrid variant={variant} size={96} resolution={24} />
            </div>
            <span className="text-muted-foreground font-mono text-xs">{label}</span>
          </div>
        ))}
      </div>

      <h2 className="text-muted-foreground mt-4 font-mono text-sm tracking-widest uppercase">
        Hero Size — 96px, res 32 (round dots)
      </h2>
      <div className="flex gap-12">
        {VARIANTS.map(({ variant, label }) => (
          <div key={variant} className="flex flex-col items-center gap-4">
            <div className="flex items-center justify-center rounded-2xl bg-black/90 p-10">
              <CircularPixelGrid variant={variant} size={96} resolution={32} dotShape="round" />
            </div>
            <span className="text-muted-foreground font-mono text-xs">{label}</span>
          </div>
        ))}
      </div>
    </div>
  ),
};

/* ── Gap Comparison ──────────────────────────────────────── */

export const GapComparison: StoryObj<typeof CircularPixelGrid> = {
  render: () => {
    const gaps = [0, 0.1, 0.2, 0.3, 0.4];
    return (
      <div className="flex flex-col gap-10">
        <h2 className="text-muted-foreground font-mono text-sm tracking-widest uppercase">
          Gap Comparison — "thinking" 60px, res 16
        </h2>
        <div className="flex items-end gap-8">
          {gaps.map((g) => (
            <div key={g} className="flex flex-col items-center gap-3">
              <div className="flex items-center justify-center rounded-xl bg-black/80 p-6">
                <CircularPixelGrid variant="thinking" size={60} resolution={16} gap={g} />
              </div>
              <span className="text-muted-foreground font-mono text-xs">gap {g}</span>
            </div>
          ))}
        </div>
      </div>
    );
  },
};

/* ── Interactive Tuner ───────────────────────────────────── */

export const Tuner: StoryObj<typeof CircularPixelGrid> = {
  args: {
    variant: "thinking",
    size: 72,
    resolution: 16,
    gap: 0.2,
    dotShape: "square",
  },
  render: (args) => (
    <div className="flex flex-col gap-8">
      <h2 className="text-muted-foreground font-mono text-sm tracking-widest uppercase">
        Tuner — adjust controls in the panel
      </h2>
      <div className="flex items-start gap-12">
        <div className="flex flex-col items-center gap-3">
          <div className="flex items-center justify-center rounded-2xl bg-black/90 p-10">
            <CircularPixelGrid {...args} />
          </div>
          <span className="text-2xs text-muted-foreground">Dark bg</span>
        </div>
        <div className="flex flex-col items-center gap-3">
          <div className="border-border/40 flex items-center justify-center rounded-2xl border bg-white p-10">
            <CircularPixelGrid {...args} />
          </div>
          <span className="text-2xs text-muted-foreground">Light bg</span>
        </div>
        <div className="flex flex-col items-center gap-3">
          <div className="flex items-center justify-center rounded-2xl p-10">
            <CircularPixelGrid {...args} />
          </div>
          <span className="text-2xs text-muted-foreground">Theme bg</span>
        </div>
      </div>
      {/* All variants with same tuning */}
      <div className="mt-4 flex gap-10">
        {VARIANTS.map(({ variant, label }) => (
          <div key={variant} className="flex flex-col items-center gap-3">
            <CircularPixelGrid
              variant={variant}
              size={args.size}
              resolution={args.resolution}
              gap={args.gap}
              dotShape={args.dotShape}
            />
            <span className="text-2xs text-muted-foreground">{label}</span>
          </div>
        ))}
      </div>
    </div>
  ),
};

/* ── Thinking vs Working: Active vs Ambient ──────────────── */

export const ThinkingVsWorking: StoryObj<typeof CircularPixelGrid> = {
  render: () => (
    <div className="flex flex-col gap-12">
      <div>
        <h2 className="text-muted-foreground font-mono text-sm tracking-widest uppercase">
          Thinking vs Working — Active vs Ambient
        </h2>
        <p className="text-muted-foreground mt-2 text-xs">
          "Thinking" is dynamic — rotating sweep + radial pulse for active processing. "Working" is
          calm — gentle breathing that just says "still going."
        </p>
      </div>

      {/* Large comparison */}
      <div className="flex gap-16">
        <div className="flex flex-col items-center gap-4">
          <div className="flex items-center justify-center rounded-2xl bg-black/90 p-10">
            <CircularPixelGrid variant="thinking" size={72} resolution={16} />
          </div>
          <div className="text-center">
            <span className="text-foreground block text-sm font-medium">Thinking</span>
            <span className="text-muted-foreground text-xs">Chat indicator — active, dynamic</span>
          </div>
        </div>
        <div className="flex flex-col items-center gap-4">
          <div className="flex items-center justify-center rounded-2xl bg-black/90 p-10">
            <CircularPixelGrid variant="working" size={72} resolution={16} />
          </div>
          <div className="text-center">
            <span className="text-foreground block text-sm font-medium">Working</span>
            <span className="text-muted-foreground text-xs">Sidebar indicator — calm, ambient</span>
          </div>
        </div>
      </div>

      {/* Sidebar context simulation */}
      <div className="flex flex-col gap-3">
        <h3 className="text-foreground text-sm font-medium">Sidebar Context — Workspace Rows</h3>
        <div className="bg-sidebar flex w-80 flex-col rounded-lg p-2">
          {[
            { name: "feat/auth-refactor", working: true },
            { name: "fix/nav-crash", working: true },
            { name: "main", working: false },
            { name: "chore/deps-update", working: true },
          ].map((ws) => (
            <div
              key={ws.name}
              className="hover:bg-accent flex items-center gap-2 rounded-md px-2 py-1.5"
            >
              {ws.working ? (
                <CircularPixelGrid variant="working" size={14} resolution={8} gap={0.15} />
              ) : (
                <div className="bg-muted-foreground/20 h-3.5 w-3.5 rounded-full" />
              )}
              <span className="text-sidebar-foreground text-sm">{ws.name}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Size comparison for both */}
      <div className="flex flex-col gap-3">
        <h3 className="text-foreground text-sm font-medium">Size Comparison</h3>
        <div className="flex gap-12">
          {[14, 20, 36, 48].map((s) => (
            <div key={s} className="flex flex-col items-center gap-4">
              <div className="flex items-center gap-6">
                <div className="flex flex-col items-center gap-1">
                  <CircularPixelGrid variant="thinking" size={s} resolution={s < 20 ? 8 : 12} />
                  <span className="text-muted-foreground text-[9px]">thinking</span>
                </div>
                <div className="flex flex-col items-center gap-1">
                  <CircularPixelGrid variant="working" size={s} resolution={s < 20 ? 8 : 12} />
                  <span className="text-muted-foreground text-[9px]">working</span>
                </div>
              </div>
              <span className="text-muted-foreground font-mono text-[10px]">{s}px</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  ),
};

/* ── Design Exploration: Color Palettes ──────────────────── */

/**
 * Current problem: thinking & compacting both use --primary (rose).
 * They're visually identical — only the animation pattern distinguishes them.
 *
 * This story explores distinct color palettes for each state.
 * All colors use equiluminant OKLCH (L≈0.68) for dark mode comfort.
 */
export const ColorExploration: StoryObj<typeof CircularPixelGrid> = {
  render: () => {
    // Color palette options to explore
    const palettes = [
      {
        name: "Current (theme defaults)",
        desc: "thinking & compacting share primary/rose — hard to tell apart",
        colors: {
          thinking: undefined, // --primary (rose h345)
          generating: undefined, // --success (green h155)
          toolExecuting: undefined, // --warning (amber h75)
          error: undefined, // --destructive (red h25)
          compacting: undefined, // --status-compacting = --primary (rose h345)
        },
      },
      {
        name: "Option A: Indigo thinking, Violet compacting",
        desc: "Cool blue for contemplation, violet for compression — classic separation",
        colors: {
          thinking: "oklch(0.68 0.14 265)", // indigo
          generating: undefined, // keep green
          toolExecuting: undefined, // keep amber
          error: undefined, // keep red
          compacting: "oklch(0.68 0.14 300)", // violet
        },
      },
      {
        name: "Option B: Cyan thinking, Magenta compacting",
        desc: "Maximum hue distance between the two previously-identical states",
        colors: {
          thinking: "oklch(0.68 0.12 210)", // cyan/teal
          generating: undefined, // keep green
          toolExecuting: undefined, // keep amber
          error: undefined, // keep red
          compacting: "oklch(0.68 0.12 330)", // magenta/pink
        },
      },
      {
        name: "Option C: Keep rose thinking, Purple compacting",
        desc: "Thinking stays brand-aligned (primary/rose), compacting gets purple",
        colors: {
          thinking: undefined, // keep primary/rose
          generating: undefined, // keep green
          toolExecuting: undefined, // keep amber
          error: undefined, // keep red
          compacting: "oklch(0.68 0.15 285)", // rich purple
        },
      },
      {
        name: "Option D: Blue thinking, Teal compacting",
        desc: "Different temperature — warm actions (amber/red), cool processing (blue/teal)",
        colors: {
          thinking: "oklch(0.68 0.13 250)", // blue
          generating: undefined, // keep green
          toolExecuting: undefined, // keep amber
          error: undefined, // keep red
          compacting: "oklch(0.68 0.11 190)", // teal/cyan
        },
      },
    ];

    const variants: CircularPixelGridVariant[] = [
      "thinking",
      "generating",
      "toolExecuting",
      "error",
      "compacting",
    ];
    const labels = ["Thinking", "Generating", "Tool Exec", "Error", "Compacting"];

    return (
      <div className="flex flex-col gap-12">
        <div>
          <h2 className="text-muted-foreground font-mono text-sm tracking-widest uppercase">
            Color Palette Exploration — 60px, res 16
          </h2>
          <p className="text-muted-foreground mt-2 text-xs">
            Each row is a different color palette. Compare how well the 5 states are distinguishable
            at a glance.
          </p>
        </div>

        {palettes.map((palette) => (
          <div key={palette.name} className="flex flex-col gap-3">
            <div>
              <h3 className="text-foreground text-sm font-medium">{palette.name}</h3>
              <p className="text-muted-foreground text-xs">{palette.desc}</p>
            </div>
            <div className="flex items-center gap-6">
              {variants.map((variant, i) => (
                <div key={variant} className="flex flex-col items-center gap-2">
                  <div className="flex items-center justify-center rounded-xl bg-black/80 p-5">
                    <CircularPixelGrid
                      variant={variant}
                      size={60}
                      resolution={16}
                      color={palette.colors[variant]}
                    />
                  </div>
                  <span className="text-muted-foreground text-[10px]">{labels[i]}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  },
};

/* ── Design Exploration: Ideal Sizes ─────────────────────── */

/**
 * How the circular grid looks at the actual sizes where it'll be used,
 * with tuned resolution for each size bracket.
 */
export const IdealSizes: StoryObj<typeof CircularPixelGrid> = {
  render: () => {
    // The three real usage contexts and their ideal settings
    const contexts = [
      {
        name: "Chat Indicator",
        desc: "Main working indicator below chat messages",
        size: 20,
        resolution: 12,
        gap: 0.15,
      },
      {
        name: "Tab Indicator",
        desc: "Small indicator in workspace tab bar",
        size: 14,
        resolution: 8,
        gap: 0.15,
      },
      {
        name: "Sidebar Item",
        desc: "Workspace initializing indicator",
        size: 14,
        resolution: 8,
        gap: 0.15,
      },
    ];

    const variants: CircularPixelGridVariant[] = [
      "thinking",
      "generating",
      "toolExecuting",
      "error",
      "compacting",
    ];

    // Option C colors (rose thinking, purple compacting)
    const colorOverrides: Partial<Record<CircularPixelGridVariant, string>> = {
      compacting: "oklch(0.68 0.15 285)",
    };

    return (
      <div className="flex flex-col gap-12">
        <h2 className="text-muted-foreground font-mono text-sm tracking-widest uppercase">
          Ideal Sizes for Real Usage Contexts
        </h2>

        {contexts.map((ctx) => (
          <div key={ctx.name} className="flex flex-col gap-3">
            <div>
              <h3 className="text-foreground text-sm font-medium">
                {ctx.name} — {ctx.size}px, res {ctx.resolution}
              </h3>
              <p className="text-muted-foreground text-xs">{ctx.desc}</p>
            </div>
            <div className="flex items-center gap-6">
              {variants.map((variant) => (
                <div key={variant} className="flex items-center gap-2">
                  <CircularPixelGrid
                    variant={variant}
                    size={ctx.size}
                    resolution={ctx.resolution}
                    gap={ctx.gap}
                    color={colorOverrides[variant]}
                  />
                  <span className="text-muted-foreground text-[10px] capitalize">
                    {variant.replace("toolExecuting", "tool").replace("Executing", "")}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}

        {/* Inline context simulation */}
        <div className="flex flex-col gap-3">
          <h3 className="text-foreground text-sm font-medium">
            In Context — Chat indicator with timer
          </h3>
          <div className="flex flex-col gap-3">
            {[
              { v: "thinking" as const, t: "3.2s", c: "text-primary" },
              { v: "generating" as const, t: "1:23.4", c: "text-success" },
              { v: "toolExecuting" as const, t: "45.1s", c: "text-warning" },
              { v: "error" as const, t: "2:01.7", c: "text-destructive" },
              { v: "compacting" as const, t: "5.0s", c: "text-primary" },
            ].map(({ v, t, c }) => (
              <div key={v} className={`flex items-center gap-2 px-2 py-1 ${c}`}>
                <CircularPixelGrid
                  variant={v}
                  size={20}
                  resolution={12}
                  gap={0.15}
                  color={colorOverrides[v]}
                />
                <span className="font-mono text-xs tabular-nums opacity-60">{t}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  },
};
