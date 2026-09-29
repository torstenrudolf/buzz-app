import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../../src/shared/design-system/styles/globals.css";
import { Avatar } from "../../../src/shared/design-system/ui/Avatar";
import { ThinkingBadge } from "../../../src/shared/design-system/ui/agent-thinking/ThinkingBadge";
function Fixture() {
  const [thinking, setThinking] = useState(false);
  const [size, setSize] = useState(88);
  return (
    <main style={{ padding: 40 }}>
      <label>
        Avatar size{" "}
        <select
          value={size}
          onChange={(event) => setSize(Number(event.target.value))}
        >
          {[24, 32, 40, 80, 88, 256].map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <article aria-label="Centered Start pill">
        <div style={{ width: size, height: size, marginBlock: 40 }}>
          <ThinkingBadge thinking={thinking} avatarSize={size}>
            <Avatar alt="Agent" fallback="A" size="fill" shape="squircle" />
          </ThinkingBadge>
        </div>
        <button type="button" onClick={() => setThinking(false)}>
          Available
        </button>
        <button type="button" onClick={() => setThinking(true)}>
          Thinking
        </button>
      </article>
    </main>
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixture />);
