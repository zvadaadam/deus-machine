import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentDotsAnimation } from "./AgentDotsAnimation";

const meta = {
  title: "Onboarding/AgentDotsAnimation",
  component: AgentDotsAnimation,
  parameters: {
    layout: "centered",
  },
  argTypes: {
    size: { control: { type: "range", min: 100, max: 800, step: 50 } },
    dotColor: { control: "color" },
    backgroundColor: { control: "color" },
    autoPlay: { control: "boolean" },
    loop: { control: "boolean" },
  },
} satisfies Meta<typeof AgentDotsAnimation>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Default: white dots on black, auto-playing, 400px */
export const Default: Story = {
  args: {
    size: 400,
    dotColor: "#fff",
    backgroundColor: "#000",
    autoPlay: true,
    loop: false,
  },
};

/** Looping variant for continuous display */
export const Looping: Story = {
  args: {
    size: 400,
    dotColor: "#fff",
    backgroundColor: "#000",
    autoPlay: true,
    loop: true,
  },
};

/** Transparent background — how it would look overlaid on the app */
export const Transparent: Story = {
  args: {
    size: 400,
    dotColor: "#fff",
    backgroundColor: "transparent",
    autoPlay: true,
    loop: true,
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

/** Small size for inline use (e.g. loading indicator) */
export const Small: Story = {
  args: {
    size: 120,
    dotColor: "#fff",
    backgroundColor: "#000",
    autoPlay: true,
    loop: true,
  },
};

/** Large cinematic size */
export const Large: Story = {
  args: {
    size: 600,
    dotColor: "#fff",
    backgroundColor: "#000",
    autoPlay: true,
    loop: false,
  },
};

/** Themed with the app's primary color */
export const Themed: Story = {
  args: {
    size: 400,
    dotColor: "oklch(0.59 0.24 264)",
    backgroundColor: "#0a0a0a",
    autoPlay: true,
    loop: true,
  },
};
