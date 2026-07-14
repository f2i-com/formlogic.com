import type { ReactNode } from 'react';

/** The FormLogic wordmark (three-bar tile + name) used in the nav and footer. */
export function FormLogicMark() {
  return (
    <span className="lv2-mark">
      <span className="lv2-mark__tile" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>FormLogic</span>
    </span>
  );
}

/** Section eyebrow label with the accent dash(es). `light` = for dark bands. */
export function SectionLabel({
  both = false,
  light = false,
  children,
}: {
  both?: boolean;
  light?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={`lv2-label${both ? ' lv2-label--both' : ''}${light ? ' lv2-label--light' : ''}`}
    >
      {children}
    </span>
  );
}
