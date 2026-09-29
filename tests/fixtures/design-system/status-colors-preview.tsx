import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter/wght.css";
import "../../../src/shared/design-system/styles/globals.css";
import { Avatar } from "../../../src/shared/design-system/ui/Avatar";

function Preview() {
  return (
    <main>
      <h1>Avatar badge colors</h1>
      <p>
        Away now uses a solid Amber 10 fill without a stroke. Online, Offline,
        avatar sizes, and the Bézier notch stay unchanged.
      </p>
      <div className="comparison">
        {(["light", "dark"] as const).flatMap((mode) =>
          [true, false].map((before) => (
            <section
              key={`${mode}-${before}`}
              className={`panel ${mode} ${before ? "before" : ""}`}
            >
              <h2>
                {mode === "light" ? "Light" : "Dark"} ·{" "}
                {before ? "before · outlined Away" : "after · solid Away"}
              </h2>
              {(["circle", "squircle"] as const).map((shape) => (
                <div className="avatar-row" key={shape}>
                  {(["online", "away", "offline"] as const).map((status) => (
                    <div className="example" key={status}>
                      <div className="sizes">
                        {(status === "offline"
                          ? (["large"] as const)
                          : (["small", "default", "large"] as const)
                        ).map((size) => (
                          <Avatar
                            key={size}
                            alt={shape === "circle" ? "Person" : "Agent"}
                            fallback={shape === "circle" ? "P" : "A"}
                            size={size}
                            shape={shape}
                            statusBadge={status}
                          />
                        ))}
                      </div>
                      <span>{status}</span>
                    </div>
                  ))}
                </div>
              ))}
            </section>
          )),
        )}
      </div>
      <p className="note">
        Real Avatar components at 24, 32, and 40px, in both shapes and themes.
        Known accessibility tradeoff: light Away measures 1.22–1.71:1 against
        supported opaque surfaces, below the 3:1 non-text contrast target. Dark
        Away remains above 3:1 on those surfaces.
      </p>
      <p className="note">
        “Before” reproduces the previous Away outline on the same shared Avatar
        component. “After” uses the current production styles.
      </p>
    </main>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Preview />);
