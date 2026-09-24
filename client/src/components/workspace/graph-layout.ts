export type LayoutPoint = { x: number; y: number };
export type LayoutCluster = { id: string; count: number };
export type LayoutView = { yaw: number; pitch: number; scale: number; panX: number; panY: number };

export const BLOB_PAD = 42;
export const CLUSTER_GAP = 72;
export const defaultView = { yaw: 0.42, pitch: 0.95 };

export const communityColors = [
  { fill: 'hsla(262, 28%, 64%, 0.16)', stroke: 'hsla(262, 28%, 70%, 0.78)' },
  { fill: 'hsla(206, 22%, 64%, 0.16)', stroke: 'hsla(206, 22%, 72%, 0.78)' },
  { fill: 'hsla(150, 16%, 56%, 0.18)', stroke: 'hsla(150, 16%, 64%, 0.78)' },
  { fill: 'hsla(28, 22%, 60%, 0.16)', stroke: 'hsla(28, 22%, 68%, 0.78)' },
  { fill: 'hsla(40, 20%, 60%, 0.16)', stroke: 'hsla(40, 20%, 68%, 0.75)' },
  { fill: 'hsla(345, 16%, 62%, 0.16)', stroke: 'hsla(345, 16%, 70%, 0.75)' },
];

export function memberRing(count: number) {
  return count <= 1 ? 0 : 46 + count * 5;
}

export function communityRadius(count: number) {
  if (count < 2) return 22;
  return memberRing(count) + BLOB_PAD;
}

export function convexHull(points: LayoutPoint[]) {
  const sorted = [...points].sort((left, right) => left.x - right.x || left.y - right.y);
  if (sorted.length <= 2) return sorted;
  const cross = (origin: LayoutPoint, left: LayoutPoint, right: LayoutPoint) => (left.x - origin.x) * (right.y - origin.y) - (left.y - origin.y) * (right.x - origin.x);
  const lower: LayoutPoint[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: LayoutPoint[] = [];
  for (const point of [...sorted].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

export function communityOutline(points: LayoutPoint[], pad: number) {
  const hull = convexHull(points);
  if (hull.length === 0) return [];
  if (hull.length === 1) return Array.from({ length: 8 }, (_, index) => {
    const angle = (index / 8) * Math.PI * 2;
    return { x: hull[0].x + Math.cos(angle) * pad, y: hull[0].y + Math.sin(angle) * pad };
  });
  if (hull.length === 2) {
    const start = hull[0];
    const end = hull[1];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy) || 1;
    const nx = -dy / length * pad;
    const ny = dx / length * pad;
    return [
      { x: start.x + nx, y: start.y + ny },
      { x: end.x + nx, y: end.y + ny },
      { x: end.x - nx, y: end.y - ny },
      { x: start.x - nx, y: start.y - ny },
    ];
  }
  const center = hull.reduce((sum, point) => ({ x: sum.x + point.x / hull.length, y: sum.y + point.y / hull.length }), { x: 0, y: 0 });
  return hull.map((point, index) => {
    const previous = hull[(index + hull.length - 1) % hull.length];
    const next = hull[(index + 1) % hull.length];
    const outward = (from: LayoutPoint, to: LayoutPoint) => {
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const length = Math.hypot(dx, dy) || 1;
      return { x: dy / length, y: -dx / length };
    };
    const left = outward(previous, point);
    const right = outward(point, next);
    let ox = left.x + right.x;
    let oy = left.y + right.y;
    const length = Math.hypot(ox, oy) || 1;
    ox /= length;
    oy /= length;
    if ((point.x - center.x) * ox + (point.y - center.y) * oy < 0) {
      ox *= -1;
      oy *= -1;
    }
    return { x: point.x + ox * pad, y: point.y + oy * pad };
  });
}

// Depth is stretched by 1/cos(pitch) before yaw, so the default terrain view keeps the packed gap after foreshortening.
export function layoutClusterCenters(clusters: LayoutCluster[]) {
  const centers = new Map<string, LayoutPoint>();
  if (clusters.length === 0) return centers;
  if (clusters.length === 1) {
    centers.set(clusters[0].id, { x: 0, y: 0 });
    return centers;
  }
  const radii = clusters.map((cluster) => communityRadius(cluster.count));
  let orbit = 0;
  for (let index = 0; index < clusters.length; index += 1) {
    const next = (index + 1) % clusters.length;
    const need = radii[index] + radii[next] + CLUSTER_GAP;
    orbit = Math.max(orbit, need / (2 * Math.sin(Math.PI / clusters.length)));
  }
  const pitchScale = Math.cos(defaultView.pitch) || 0.2;
  const cosYaw = Math.cos(defaultView.yaw);
  const sinYaw = Math.sin(defaultView.yaw);
  clusters.forEach((cluster, index) => {
    const angle = (index / clusters.length) * Math.PI * 2 - Math.PI / 2;
    const screenX = Math.cos(angle) * orbit;
    const screenY = Math.sin(angle) * orbit;
    const turnedX = screenX;
    const turnedY = screenY / pitchScale;
    centers.set(cluster.id, {
      x: cosYaw * turnedX + sinYaw * turnedY,
      y: -sinYaw * turnedX + cosYaw * turnedY,
    });
  });
  return centers;
}

export function projectGround(x: number, y: number, lift: number, view: LayoutView, width: number, height: number, scene: boolean) {
  const turnedX = scene ? x * Math.cos(view.yaw) - y * Math.sin(view.yaw) : x;
  const turnedY = scene ? x * Math.sin(view.yaw) + y * Math.cos(view.yaw) : y;
  const rise = scene ? lift * 150 * Math.sin(view.pitch) : 0;
  const ground = scene ? turnedY * Math.cos(view.pitch) : turnedY;
  return {
    x: width / 2 + turnedX * view.scale + view.panX,
    y: (scene ? height * 0.4 : height / 2) + (ground - rise) * view.scale + view.panY,
  };
}

export function fittedScale(clusters: LayoutCluster[], width: number, height: number, scene: boolean) {
  if (width < 40 || height < 40 || clusters.length === 0) return scene ? 0.84 : 1;
  const centers = layoutClusterCenters(clusters);
  const view = { ...defaultView, scale: 1, panX: 0, panY: 0 };
  const anchor = projectGround(0, 0, 0, view, 0, 0, scene);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const cluster of clusters) {
    const center = centers.get(cluster.id) ?? { x: 0, y: 0 };
    const projected = projectGround(center.x, center.y, 0, view, 0, 0, scene);
    const radius = communityRadius(cluster.count);
    const x = projected.x - anchor.x;
    const y = projected.y - anchor.y;
    const reachY = scene ? radius * Math.cos(defaultView.pitch) : radius;
    minX = Math.min(minX, x - radius);
    maxX = Math.max(maxX, x + radius);
    minY = Math.min(minY, y - reachY);
    maxY = Math.max(maxY, y + reachY);
  }
  const anchorY = scene ? height * 0.4 : height / 2;
  const limits = [1.2];
  if (minX < -1) limits.push((16 - width / 2) / minX);
  if (maxX > 1) limits.push((width - 16 - width / 2) / maxX);
  if (minY < -1) limits.push((72 - anchorY) / minY);
  if (maxY > 1) limits.push((height - 28 - anchorY) / maxY);
  return Math.max(0.32, Math.min(...limits) * 0.92);
}

function pointInPolygon(point: LayoutPoint, polygon: LayoutPoint[]) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const current = polygon[index];
    const prior = polygon[previous];
    const crosses = (current.y > point.y) !== (prior.y > point.y);
    if (!crosses) continue;
    const x = ((prior.x - current.x) * (point.y - current.y)) / ((prior.y - current.y) || 1e-9) + current.x;
    if (point.x < x) inside = !inside;
  }
  return inside;
}

function segmentDistance(a1: LayoutPoint, a2: LayoutPoint, b1: LayoutPoint, b2: LayoutPoint) {
  const ux = a2.x - a1.x;
  const uy = a2.y - a1.y;
  const vx = b2.x - b1.x;
  const vy = b2.y - b1.y;
  const wx = a1.x - b1.x;
  const wy = a1.y - b1.y;
  const a = ux * ux + uy * uy;
  const b = ux * vx + uy * vy;
  const c = vx * vx + vy * vy;
  const d = ux * wx + uy * wy;
  const e = vx * wx + vy * wy;
  const determinant = a * c - b * b;
  let sNumerator: number;
  let sDenominator = determinant;
  let tNumerator: number;
  let tDenominator = determinant;
  if (determinant < 1e-8) {
    sNumerator = 0;
    sDenominator = 1;
    tNumerator = e;
    tDenominator = c;
  } else {
    sNumerator = b * e - c * d;
    tNumerator = a * e - b * d;
    if (sNumerator < 0) {
      sNumerator = 0;
      tNumerator = e;
      tDenominator = c;
    } else if (sNumerator > sDenominator) {
      sNumerator = sDenominator;
      tNumerator = e + b;
      tDenominator = c;
    }
  }
  if (tNumerator < 0) {
    tNumerator = 0;
    if (-d < 0) sNumerator = 0;
    else if (-d > a) sNumerator = sDenominator;
    else { sNumerator = -d; sDenominator = a; }
  } else if (tNumerator > tDenominator) {
    tNumerator = tDenominator;
    if (-d + b < 0) sNumerator = 0;
    else if (-d + b > a) sNumerator = sDenominator;
    else { sNumerator = -d + b; sDenominator = a; }
  }
  const sc = Math.abs(sNumerator) < 1e-8 ? 0 : sNumerator / (sDenominator || 1);
  const tc = Math.abs(tNumerator) < 1e-8 ? 0 : tNumerator / (tDenominator || 1);
  return Math.hypot(wx + sc * ux - tc * vx, wy + sc * uy - tc * vy);
}

export function outlineGap(left: LayoutPoint[], right: LayoutPoint[]) {
  if (left.length < 3 || right.length < 3) return 0;
  if (left.some((point) => pointInPolygon(point, right)) || right.some((point) => pointInPolygon(point, left))) return 0;
  let gap = Infinity;
  for (let i = 0; i < left.length; i += 1) {
    for (let j = 0; j < right.length; j += 1) {
      gap = Math.min(gap, segmentDistance(left[i], left[(i + 1) % left.length], right[j], right[(j + 1) % right.length]));
    }
  }
  return gap;
}

export function memberHomes(count: number, center: LayoutPoint) {
  return Array.from({ length: count }, (_, index) => {
    const ring = memberRing(count);
    const angle = (index / Math.max(count, 1)) * Math.PI * 2 - Math.PI / 2;
    return { x: center.x + Math.cos(angle) * ring, y: center.y + Math.sin(angle) * ring };
  });
}
