type Point = { x: number; y: number };
type Arc = [Point, Point, ...Point[]];
const TAU = Math.PI * 2;
const xy = (p: Point) => `${p.x.toFixed(4)} ${p.y.toFixed(4)}`;
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

// The shared avatar-squircle.svg's four cubic quadrants, in the 88px canvas.
function avatarPoint(t: number): Point {
  const quadrant = Math.floor(t) % 4;
  const u = t - Math.floor(t);
  const v = 1 - u;
  const x = 0.5 * v ** 3 + 3 * 0.93 * v ** 2 * u + 3 * v * u ** 2 + u ** 3;
  const y = 3 * 0.07 * v * u ** 2 + 0.5 * u ** 3;
  const points = [
    [x, y],
    [1 - y, x],
    [1 - x, 1 - y],
    [y, 1 - x],
  ] as const;
  const point = points[quadrant] ?? points[0];
  return { x: point[0] * 88, y: point[1] * 88 };
}

/** One continuous avatar outline with tangent joins into a moving capsule notch.
 * The joins are present at every frame, including both resting endpoints.
 */
export function badgeCutoutPath(
  x: number,
  y: number,
  width: number,
  height: number,
  gap: number,
  progress = 0,
  outerJoinRounding = 1,
) {
  const radius = height / 2 + gap;
  const straight = (width - height) / 2;
  const power = 5 - 3 * progress;
  const inside = (p: Point) =>
    (Math.max(0, Math.abs(p.x - x) - straight) / radius) ** power +
      (Math.abs(p.y - y) / radius) ** power <
    1;
  // Both crossings lie on the lower half of the avatar. Bisect only these arcs.
  const crossings: number[] = [];
  for (let i = 0; i < 64; i++) {
    let a = 1 + i / 32;
    let b = a + 1 / 32;
    const startsInside = inside(avatarPoint(a));
    if (startsInside === inside(avatarPoint(b))) continue;
    for (let step = 0; step < 16; step++) {
      const middle = (a + b) / 2;
      if (inside(avatarPoint(middle)) === startsInside) a = middle;
      else b = middle;
    }
    crossings.push((a + b) / 2);
  }
  const enter = crossings[0];
  const leave = crossings[1];
  if (enter === undefined || leave === undefined)
    return `M ${Array.from({ length: 257 }, (_, i) => xy(avatarPoint(i / 64))).join(" L ")} Z`;
  const a = avatarPoint(enter);
  const b = avatarPoint(leave);
  const angle = (p: Point) => {
    const dx =
      (Math.sign(p.x - x) * Math.max(0, Math.abs(p.x - x) - straight)) / radius;
    const dy = (p.y - y) / radius;
    return Math.atan2(
      Math.sign(dy) * Math.abs(dy) ** (power / 2),
      Math.sign(dx) * Math.abs(dx) ** (power / 2),
    );
  };
  const start = angle(a);
  let end = angle(b);
  while (end >= start) end -= TAU;
  const holePoint = (t: number) => {
    const theta = start + (end - start) * t;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    return {
      x:
        x + Math.sign(cos) * (straight + radius * Math.abs(cos) ** (2 / power)),
      y: y + radius * Math.sign(sin) * Math.abs(sin) ** (2 / power),
    };
  };
  // Solve trim positions continuously instead of snapping them to sampled vertices.
  const trimArc = (
    point: (t: number) => Point,
    first: Point,
    last: Point,
    samples: number,
    rounding = 1,
  ) => {
    // Match the shared status masks' soft cubic joins. Tie the pullback to
    // badge size, not the capped clearance, so portrait joins stay curved.
    const trim = Math.min(width, height) * 0.35 * rounding;
    const endpoint = (origin: Point, reverse: boolean) => {
      let low = 0;
      let high = 0.25;
      for (let i = 0; i < 16; i++) {
        const t = (low + high) / 2;
        if (distance(point(reverse ? 1 - t : t), origin) < trim) low = t;
        else high = t;
      }
      return reverse ? 1 - high : high;
    };
    const from = endpoint(first, false);
    const to = endpoint(last, true);
    return Array.from({ length: samples + 1 }, (_, i) =>
      point(from + ((to - from) * i) / samples),
    ) as Arc;
  };
  const notch = trimArc(holePoint, a, b, 128);
  const rim = trimArc(
    (t) => avatarPoint(leave + (4 + enter - leave) * t),
    b,
    a,
    256,
    outerJoinRounding,
  );
  const join = (from: Arc, to: Arc) => {
    const start = from.at(-1) ?? from[0];
    const before = from.at(-2) ?? from[0];
    const end = to[0];
    const after = to[1];
    const handle = distance(start, end) * 0.45;
    const along = (origin: Point, target: Point, amount: number) => {
      const length = distance(origin, target);
      return {
        x: origin.x + ((target.x - origin.x) * amount) / length,
        y: origin.y + ((target.y - origin.y) * amount) / length,
      };
    };
    return `C ${xy(along(start, before, -handle))} ${xy(along(end, after, -handle))} ${xy(end)}`;
  };
  return `M ${xy(rim[0])} L ${rim.slice(1).map(xy).join(" L ")} ${join(rim, notch)} L ${notch.slice(1).map(xy).join(" L ")} ${join(notch, rim)} Z`;
}
