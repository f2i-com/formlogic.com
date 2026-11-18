import { createContext } from 'react';
import type { SidebarEdge, SidebarPosition } from '../../stores/uiStore';

/** Page headers rendered outside the workspace still provide their own account menu. */
export const AccountInDock = createContext(false);

const clamp = (value: number, max: number) => Math.max(0, Math.min(max, value));
const fraction = (value: number) => Number.isFinite(value) ? clamp(value, 1) : 0;

/** Percentages of both the parent and the panel preserve the available travel after a resize. */
export function positionStyle(point: SidebarPosition) {
  const x = fraction(point.x) * 100;
  const y = fraction(point.y) * 100;
  return { left: x + '%', top: y + '%', transform: 'translate(-' + x + '%, -' + y + '%)' };
}

export function floatingPosition(area: HTMLElement, width: number, height: number, left: number, top: number): SidebarPosition {
  const rect = area.getBoundingClientRect();
  const travelX = rect.width - width;
  const travelY = rect.height - height;
  return { x: travelX > 0 ? fraction((left - rect.left) / travelX) : 0, y: travelY > 0 ? fraction((top - rect.top) / travelY) : 0 };
}

/** In a corner, dock to the closest edge. A docked chat defines the right side of the workspace. */
export function edgeAt(rect: DOMRect, x: number, y: number): SidebarEdge | null {
  const distances: [SidebarEdge, number][] = [['left', Math.abs(x - rect.left)], ['right', Math.abs(x - rect.right)],
    ['top', Math.abs(y - rect.top)], ['bottom', Math.abs(y - rect.bottom)]];
  const [edge, distance] = distances.reduce((closest, next) => next[1] < closest[1] ? next : closest);
  if (x < rect.left - 4 || x > rect.right + 4 || y < rect.top - 4 || y > rect.bottom + 4) return null;
  return distance <= 44 ? edge : null;
}
