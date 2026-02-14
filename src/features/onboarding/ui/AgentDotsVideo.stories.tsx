import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentDotsVideo } from "./AgentDotsVideo";
import { AgentDotsAnimation } from "./AgentDotsAnimation";

const meta = {
  title: "Onboarding/AgentDotsVideo",
  component: AgentDotsVideo,
  parameters: {
    layout: "centered",
  },
  argTypes: {
    size: { control: { type: "range", min: 100, max: 800, step: 50 } },
    format: { control: "radio", options: ["webm", "mp4"] },
    autoPlay: { control: "boolean" },
    loop: { control: "boolean" },
  },
} satisfies Meta<typeof AgentDotsVideo>;

export default meta;
type Story = StoryObj<typeof meta>;

/** WebM with alpha — transparent background */
export const TransparentWebM: Story = {
  args: {
    size: 400,
    format: "webm",
    autoPlay: true,
    loop: false,
  },
  decorators: [
    (Story) => (
      <div
        style={{
          background:
            "repeating-conic-gradient(#808080 0% 25%, transparent 0% 50%) 50% / 20px 20px",
          borderRadius: 12,
        }}
      >
        <Story />
      </div>
    ),
  ],
};

/** MP4 with black background */
export const BlackMP4: Story = {
  args: {
    size: 400,
    format: "mp4",
    autoPlay: true,
    loop: false,
  },
};

/** WebM looping on dark background — onboarding preview */
export const OnboardingPreview: Story = {
  args: {
    size: 400,
    format: "webm",
    autoPlay: true,
    loop: true,
  },
  decorators: [
    (Story) => (
      <div
        style={{
          background: "#0a0a0a",
          borderRadius: 12,
          padding: 40,
        }}
      >
        <Story />
      </div>
    ),
  ],
};

/** Side-by-side comparison: Live SVG vs Pre-rendered Video */
export const CompareWithLive: Story = {
  args: {
    size: 300,
    format: "webm",
    autoPlay: true,
    loop: true,
  },
  render: (args) => {
    return (
      <div style={{ display: "flex", gap: 40, alignItems: "center" }}>
        <div style={{ textAlign: "center" }}>
          <AgentDotsAnimation size={args.size} backgroundColor="#000" autoPlay loop />
          <p style={{ color: "#888", marginTop: 12, fontSize: 13 }}>Live React/SVG (~4KB)</p>
        </div>
        <div style={{ textAlign: "center" }}>
          <AgentDotsVideo {...args} />
          <p style={{ color: "#888", marginTop: 12, fontSize: 13 }}>
            Pre-rendered WebM ({(233).toLocaleString()}KB)
          </p>
        </div>
      </div>
    );
  },
};
