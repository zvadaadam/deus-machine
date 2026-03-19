import { Composition } from "remotion";
import { Orchestrator } from "./Orchestrator";
import { OrchestratorTransparent } from "./OrchestratorTransparent";

export const RemotionRoot = () => {
  return (
    <>
      <Composition
        id="Orchestrator"
        component={Orchestrator}
        durationInFrames={300}
        fps={30}
        width={1080}
        height={1080}
      />
      <Composition
        id="OrchestratorTransparent"
        component={OrchestratorTransparent}
        durationInFrames={300}
        fps={30}
        width={1080}
        height={1080}
      />
    </>
  );
};
