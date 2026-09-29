import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentAvatar } from "../../src/features/agents/AgentAvatar";
import { Avatar } from "../../src/shared/design-system/ui/Avatar";
import "../../src/shared/styles/globals.css";

function Fixture() {
  const [thinking, setThinking] = useState(false);
  const [picture, setPicture] = useState(false);
  return (
    <main style={{ padding: 40 }}>
      <button type="button" onClick={() => setThinking(!thinking)}>
        Toggle thinking
      </button>
      <button type="button" onClick={() => setPicture(true)}>
        Load picture
      </button>
      {[22, 40].map((size) => (
        <section
          key={size}
          aria-label={`${size}px avatars`}
          style={{ display: "flex", gap: 24, padding: 24 }}
        >
          <div style={{ width: size, height: size }}>
            <AgentAvatar
              alt="Agent"
              fallback="A"
              size="fill"
              shape="squircle"
              working={thinking}
              statusBadge="online"
              src={
                picture
                  ? "https://images.example/agent-fallback.png"
                  : undefined
              }
            />
          </div>
          <div style={{ width: size, height: size }}>
            <Avatar alt="Reference" fallback="A" size="fill" shape="squircle" />
          </div>
        </section>
      ))}
    </main>
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);
