import React from "react";
import { Composition } from "remotion";
import { AgentPeekDemo } from "./AgentPeekDemo";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="AgentPeekDemo"
      component={AgentPeekDemo}
      durationInFrames={360}
      fps={30}
      width={1600}
      height={1000}
    />
  );
};
