import React from "react";
import { Composition } from "remotion";
import { AgentPeekDemo } from "./AgentPeekDemo";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="AgentPeekDemo"
      component={AgentPeekDemo}
      durationInFrames={540}
      fps={30}
      width={1920}
      height={1080}
    />
  );
};
