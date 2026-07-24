export interface ScrollSpySection {
  id: string;
  top: number;
}

export interface ScrollSpyViewport {
  scrollY: number;
  viewportHeight: number;
  documentHeight: number;
  markerY?: number;
}

/**
 * Resolve the section intersecting the page's reading line.
 *
 * The final section is selected at the bottom of the document because short
 * trailing sections cannot always reach the reading line on tall viewports.
 */
export function resolveActiveScrollSection(
  sections: readonly ScrollSpySection[],
  viewport: ScrollSpyViewport
): string | null {
  if (sections.length === 0) return null;

  if (viewport.scrollY + viewport.viewportHeight >= viewport.documentHeight - 2) {
    return sections[sections.length - 1].id;
  }

  const markerY = viewport.markerY ?? 112;
  let activeId = sections[0].id;
  for (const section of sections) {
    if (section.top > markerY) break;
    activeId = section.id;
  }
  return activeId;
}
