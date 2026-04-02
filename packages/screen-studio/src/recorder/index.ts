export { TimelineRecorder, type TimelineFrame } from "./encoder.js";

export {
  createPlaybackPlan,
  sourceToOutputTime,
  outputToSourceTime,
  isMeaningfulAction,
  DEFAULT_SPEED_RAMP_CONFIG,
  type PlaybackSegment,
  type PlaybackPlan,
  type SpeedRampConfig,
} from "./render-plan.js";
