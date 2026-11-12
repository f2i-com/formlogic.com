// Where the form builder's bar keeps its first two groups of controls.
//
// The bar can be squeezed by a docked chat or a snapped desktop window, so this is decided from
// the bar's measured width rather than from viewport breakpoints. With room, every control
// stands in the bar ('bar'); its labels give way to icons by container query (BAR_LABEL in
// FormBuilder), which needs no measuring. Without room for the icons themselves, the "look" and
// "behavior" groups are listed in the More menu instead ('menu'). That changes what the menu
// holds, which a style rule cannot do, so it is decided here.
export type BuilderChromeTier = 'bar' | 'menu';

export const BUILDER_CHROME = {
  // The narrowest bar, inside its padding, that holds every control as an icon (418 px of them)
  // beside the back button, the form's icon and a title of about 8rem.
  BAR_MIN_W: 700,
} as const;

function measured(width: number | null | undefined): width is number {
  return typeof width === 'number' && Number.isFinite(width) && width > 0;
}

export function resolveBuilderChrome(headerWidth: number | null | undefined): BuilderChromeTier {
  if (!measured(headerWidth)) return 'bar';
  return headerWidth >= BUILDER_CHROME.BAR_MIN_W ? 'bar' : 'menu';
}
