import { describe, expect, it } from 'vitest';
import { BLOB_PAD, communityOutline, defaultView, fittedScale, layoutClusterCenters, memberHomes, outlineGap, projectGround, type LayoutView } from './graph-layout.js';

const sizes = [3, 6, 4, 8];

function clustersOf(counts: number[]) {
  return counts.map((count, index) => ({ id: `c${index}`, count }));
}

function projectedOutlines(counts: number[], width: number, height: number, pitch = defaultView.pitch) {
  const clusters = clustersOf(counts);
  const centers = layoutClusterCenters(clusters);
  const view: LayoutView = { ...defaultView, pitch, scale: fittedScale(clusters, width, height, true), panX: 0, panY: 0 };
  return clusters.filter((cluster) => cluster.count >= 2).map((cluster) => {
    const center = centers.get(cluster.id) ?? { x: 0, y: 0 };
    const world = communityOutline(memberHomes(cluster.count, center), BLOB_PAD);
    return world.map((point) => projectGround(point.x, point.y, 0, view, width, height, true));
  });
}

describe('terrain community layout', () => {
  it('keeps four differently sized outlines apart in the default view', () => {
    const outlines = projectedOutlines(sizes, 960, 576);
    expect(outlines).toHaveLength(4);
    for (const outline of outlines) expect(outline.length).toBeGreaterThanOrEqual(3);
    for (let left = 0; left < outlines.length; left += 1) {
      for (let right = left + 1; right < outlines.length; right += 1) {
        expect(outlineGap(outlines[left], outlines[right])).toBeGreaterThan(12);
      }
    }
  });

  it('keeps the same outlines apart on a narrow screen and at a steeper pitch', () => {
    for (const outlines of [projectedOutlines(sizes, 360, 448), projectedOutlines(sizes, 960, 576, 1.25)]) {
      for (let left = 0; left < outlines.length; left += 1) {
        for (let right = left + 1; right < outlines.length; right += 1) {
          expect(outlineGap(outlines[left], outlines[right])).toBeGreaterThan(8);
        }
      }
    }
  });

  it('spreads projected centers across both axes', () => {
    const centers = [...layoutClusterCenters(clustersOf(sizes)).values()];
    const view: LayoutView = { ...defaultView, scale: 1, panX: 0, panY: 0 };
    const points = centers.map((center) => projectGround(center.x, center.y, 0, view, 0, 0, true));
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);
    expect(spanX).toBeGreaterThan(200);
    expect(spanY).toBeGreaterThan(200);
    expect(Math.min(spanX, spanY) / Math.max(spanX, spanY)).toBeGreaterThan(0.65);
  });
});
