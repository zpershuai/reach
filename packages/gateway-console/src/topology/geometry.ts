import { ROUTE } from "../particles";

export interface Point {
  x: number;
  y: number;
}
export interface Route {
  d: string;
  pts: Point[];
  cum: number[];
}
export interface Geometry {
  w: number;
  h: number;
  gL: Point;
  gR: Point;
  stageX: Record<"auth" | "policy" | "route", number>;
  clients: Map<string, Route>;
  engines: Map<string, Route>;
}

export function bezier(a: Point, b: Point): Route {
  const dx = (b.x - a.x) * 0.5;
  const c1 = { x: a.x + dx, y: a.y };
  const c2 = { x: b.x - dx, y: b.y };
  const pts: Point[] = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    const u = 1 - t;
    pts.push({
      x:
        u * u * u * a.x +
        3 * u * u * t * c1.x +
        3 * u * t * t * c2.x +
        t * t * t * b.x,
      y:
        u * u * u * a.y +
        3 * u * u * t * c1.y +
        3 * u * t * t * c2.y +
        t * t * t * b.y,
    });
  }
  const cum = [0];
  for (let i = 1; i < pts.length; i++)
    cum.push(
      cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y),
    );
  return {
    d: `M${a.x},${a.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${b.x},${b.y}`,
    pts,
    cum,
  };
}

export function along(route: Route, fraction: number): Point {
  const target =
    Math.max(0, Math.min(1, fraction)) * route.cum[route.cum.length - 1];
  let index = route.cum.findIndex((length) => length >= target);
  if (index < 1) index = 1;
  const span = route.cum[index] - route.cum[index - 1] || 1;
  const t = (target - route.cum[index - 1]) / span;
  const a = route.pts[index - 1];
  const b = route.pts[index];
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Maps route progress onto client path → measured Gateway stages → Engine path. */
export function position(
  geo: Geometry,
  client: Route,
  engine: Route,
  progress: number,
): Point {
  if (progress <= ROUTE.gatewayIn)
    return along(client, progress / ROUTE.gatewayIn);
  if (progress >= ROUTE.gatewayOut)
    return along(
      engine,
      (progress - ROUTE.gatewayOut) / (1 - ROUTE.gatewayOut),
    );
  const knots: Array<[number, number]> = [
    [ROUTE.gatewayIn, geo.gL.x],
    [ROUTE.auth, geo.stageX.auth],
    [ROUTE.policy, geo.stageX.policy],
    [ROUTE.route, geo.stageX.route],
    [ROUTE.gatewayOut, geo.gR.x],
  ];
  for (let i = 1; i < knots.length; i++) {
    const [p1, x1] = knots[i];
    const [p0, x0] = knots[i - 1];
    if (progress <= p1)
      return { x: x0 + ((progress - p0) / (p1 - p0)) * (x1 - x0), y: geo.gL.y };
  }
  return geo.gR;
}
