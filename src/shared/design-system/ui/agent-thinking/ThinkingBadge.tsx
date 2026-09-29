import { useEffect, useId, useRef, type ReactNode } from "react";
import { badgeCutoutPath } from "./badge-cutout-geometry";

import "./thinking.css";

/** One silhouette travels from the corner to the compact Start-button capsule. */
export function ThinkingBadge({
  thinking,
  enabled = true,
  children,
  avatarSize = 88,
}: {
  thinking: boolean;
  enabled?: boolean;
  children: ReactNode;
  avatarSize?: number;
}) {
  const id = useId();
  const pixels = Math.max(1, avatarSize);
  const cappedScale = Math.min(1, 88 / pixels);
  const gap = Math.min(6.6, (3 * 88) / pixels);
  // Keep the available badge at its established 25% size and 85% anchor.
  // Large thinking pills grow gently with the portrait instead of hitting a hard cap.
  const scale = Math.sqrt(cappedScale);
  // Chat pills use 25% less clearance; blend back to the full gap at 80px.
  const thinkingGap =
    gap * (0.75 + 0.25 * Math.max(0, Math.min(1, (avatarSize - 40) / 40)));
  const corner = 74.8;
  const root = useRef<HTMLSpanElement>(null);
  const ink = useRef<HTMLSpanElement>(null);
  const movingNotch = useRef<SVGPathElement>(null);
  const measure = useRef<HTMLSpanElement>(null);
  const dots = useRef<HTMLSpanElement>(null);
  const progress = useRef(0);
  const dotsProgress = useRef(0);
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    function start() {
      cancelAnimationFrame(frame);
      const from = progress.current;
      const dotsFrom = dotsProgress.current;
      const to = thinking ? 1 : 0;
      const began = performance.now();
      // Use compact Start-button proportions in the 88px canvas. The avatar
      // scales the whole canvas, including the pill, dots, gaps and bounce.
      const width = (measure.current?.offsetWidth ?? 64) * scale;
      const height = (measure.current?.offsetHeight ?? 32) * scale;
      function draw(now: number) {
        const time =
          media.matches || document.hidden
            ? 1
            : Math.min(1, (now - began) / 300);
        const p = from + (to - from) * (1 - (1 - time) ** 5);
        progress.current = p;
        // Finish the dots' reveal/exit in 100ms while the shell settles over 300ms.
        const dotsTime = Math.min(1, time * 3);
        dotsProgress.current =
          dotsFrom + (to - dotsFrom) * (1 - (1 - dotsTime) ** 3);
        if (dots.current)
          dots.current.style.opacity = String(dotsProgress.current);
        const x = corner + (44 - corner) * p;
        const y = corner + (88 - corner) * p;
        const w = 22 + (width - 22) * p;
        const h = 22 + (height - 22) * p;
        movingNotch.current?.setAttribute(
          "d",
          badgeCutoutPath(
            x,
            y,
            w,
            h,
            gap + (thinkingGap - gap) * p,
            p,
            1 - 0.7 * p,
          ),
        );
        if (ink.current) {
          Object.assign(ink.current.style, {
            left: `${x}px`,
            top: `${y}px`,
            width: `${w}px`,
            height: `${h}px`,
            borderRadius: `${7 + (height / 2 - 7) * p}px`,
          });
        }
        root.current?.setAttribute(
          "data-phase",
          p === 0 ? "available" : p === 1 ? "thinking" : "morphing",
        );
        if (time < 1) frame = requestAnimationFrame(draw);
      }
      frame = requestAnimationFrame(draw);
    }
    start();
    media.addEventListener("change", start);
    document.addEventListener("visibilitychange", start);
    return () => {
      cancelAnimationFrame(frame);
      media.removeEventListener("change", start);
      document.removeEventListener("visibilitychange", start);
    };
  }, [thinking, scale, gap, thinkingGap]);
  return (
    <span
      ref={root}
      className="badge-pill-root"
      data-thinking={thinking || undefined}
      style={{ "--badge-detail-scale": scale } as React.CSSProperties}
    >
      <span
        className="badge-motion-artwork"
        style={{ clipPath: enabled ? `url(#${id}-pill)` : undefined }}
      >
        {children}
      </span>
      <svg className="badge-pill-cutout" aria-hidden="true">
        <defs>
          <clipPath id={`${id}-pill`} clipPathUnits="objectBoundingBox">
            <path
              ref={movingNotch}
              className="badge-pill-notch"
              transform={`scale(${1 / 88})`}
              d={badgeCutoutPath(corner, corner, 22, 22, gap)}
            />
          </clipPath>
        </defs>
      </svg>
      <span
        className="badge-pill-canvas"
        style={{ transform: `scale(${pixels / 88})` }}
      >
        <span
          ref={measure}
          aria-hidden="true"
          className="buzz-button badge-pill-measure"
          data-size="sm"
          data-variant="prominent"
        >
          Start
        </span>
        <span
          ref={ink}
          className="badge-pill-ink"
          aria-hidden="true"
          style={{ visibility: enabled ? "visible" : "hidden" }}
        >
          <span ref={dots} className="badge-pill-dots">
            <i />
            <i />
            <i />
          </span>
        </span>
      </span>
    </span>
  );
}
