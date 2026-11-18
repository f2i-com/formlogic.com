import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { ArrowLeftRight, Check, GripHorizontal, Menu, PanelBottom, PanelLeft, PanelRight, PanelTop, PanelsTopLeft, X } from 'lucide-react';
import { type SidebarEdge, useUIStore } from '../../stores/uiStore';
import { cn } from '../../lib/utils';
import { Popover } from '../ui/Popover';
import { Sidebar } from './Sidebar';
import { HorizontalNavigation } from './HorizontalNavigation';
import { edgeAt, floatingPosition, positionStyle } from './navigationDock';
import './navigationDock.css';

const button = 'inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-lg px-2 text-sm font-medium text-slate-600 hover:bg-slate-200/70 focus-visible:outline-2 focus-visible:outline-primary-500 dark:text-slate-300 dark:hover:bg-slate-800';
const dockEdges = [
  ['left', PanelLeft], ['top', PanelTop], ['right', PanelRight], ['bottom', PanelBottom],
] as const;

interface Drag {
  id: number;
  startX: number;
  startY: number;
  grabX: number;
  grabY: number;
  moved: boolean;
}

export function DesktopNavigation() {
  const floating = useUIStore(s => s.sidebarFloating);
  const edge = useUIStore(s => s.sidebarEdge);
  const open = useUIStore(s => s.sidebarOpen);
  const collapsed = useUIStore(s => s.sidebarCollapsed);
  const position = useUIStore(s => s.sidebarPosition);
  const setOpen = useUIStore(s => s.setSidebarOpen);
  const setFloating = useUIStore(s => s.setSidebarFloating);
  const setPosition = useUIStore(s => s.setSidebarPosition);
  const dock = useUIStore(s => s.dockSidebar);
  const [choosingEdge, setChoosingEdge] = useState(false);
  const panelId = useId();
  const launcher = useRef<HTMLButtonElement>(null);
  const floatButton = useRef<HTMLButtonElement>(null);
  const positionButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const space = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const guide = useRef<HTMLDivElement>(null);
  const guideLabel = useRef<HTMLSpanElement>(null);
  const drag = useRef<Drag | null>(null);
  const horizontal = !floating && (edge === 'top' || edge === 'bottom');

  const cancelDrag = useCallback(() => {
    if (!drag.current) return;
    drag.current = null;
    if (guide.current) guide.current.hidden = true;
    if (floating && panel.current) Object.assign(panel.current.style, positionStyle(position));
  }, [floating, position]);

  // Pointer capture keeps the grip working outside the panel. Keyboard focus can still be on the page.
  useEffect(() => {
    function escape(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape' || !drag.current) return;
      event.preventDefault();
      event.stopPropagation();
      cancelDrag();
    }
    document.addEventListener('keydown', escape, true);
    window.addEventListener('blur', cancelDrag);
    return () => {
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('blur', cancelDrag);
    };
  }, [cancelDrag]);

  function showPanel(next: boolean) {
    setOpen(next);
    requestAnimationFrame(() => (next ? closeButton : launcher).current?.focus());
  }

  function floatMenu() {
    setChoosingEdge(false);
    setFloating(true);
    requestAnimationFrame(() => closeButton.current?.focus());
  }

  function dockMenu(next: SidebarEdge) {
    setChoosingEdge(false);
    dock(next);
    requestAnimationFrame(() => (next === 'top' || next === 'bottom' ? positionButton : floatButton).current?.focus());
  }

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (!event.isPrimary || event.button !== 0 || !panel.current || !measure.current) return;
    const rect = panel.current.getBoundingClientRect();
    drag.current = {
      id: event.pointerId, startX: event.clientX, startY: event.clientY,
      grabX: floating ? event.clientX - rect.left : measure.current.offsetWidth / 2,
      grabY: floating ? event.clientY - rect.top : 20,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function dropAt(start: Drag, x: number, y: number) {
    if (!space.current || !area.current || !measure.current) return null;
    const bounds = space.current.getBoundingClientRect();
    const room = area.current.getBoundingClientRect();
    const width = measure.current.offsetWidth, height = measure.current.offsetHeight;
    const point = floatingPosition(area.current, width, height, x - start.grabX, y - start.grabY);
    // A right-docked chat narrows the workspace. The physical screen edge is also a right drop.
    const targetEdge = x > bounds.right && x >= window.innerWidth - 44 ? 'right' : edgeAt(bounds, x, y);
    return {
      edge: targetEdge, point, width, height,
      left: room.left - bounds.left + point.x * (room.width - width),
      top: room.top - bounds.top + point.y * (room.height - height),
    };
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (!start || start.id !== event.pointerId || !guide.current || !guideLabel.current) return;
    if (!start.moved && Math.hypot(start.startX - event.clientX, start.startY - event.clientY) < 5) return;
    start.moved = true;
    const target = dropAt(start, event.clientX, event.clientY);
    if (!target) return;
    const preview = guide.current;
    if (floating && !target.edge && panel.current) {
      Object.assign(panel.current.style, positionStyle(target.point));
      preview.hidden = true;
      return;
    }
    preview.hidden = false;
    preview.dataset.edge = target.edge ?? 'floating';
    for (const key of ['left', 'top', 'height', 'width'] as const) {
      preview.style[key] = target.edge ? '' : target[key] + 'px';
    }
    guideLabel.current.textContent = target.edge ? 'Dock ' + target.edge : 'Float here';
  }

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    cancelDrag();
    if (!start.moved) return;
    const target = dropAt(start, event.clientX, event.clientY);
    if (!target) return;
    if (target.edge) dockMenu(target.edge);
    else {
      setPosition(target.point);
      if (!floating) floatMenu();
    }
  }

  function nudge(event: KeyboardEvent<HTMLButtonElement>) {
    if (!area.current || !panel.current) return;
    const dx = event.key === 'ArrowLeft' ? -32 : event.key === 'ArrowRight' ? 32 : 0;
    const dy = event.key === 'ArrowUp' ? -32 : event.key === 'ArrowDown' ? 32 : 0;
    if (!dx && !dy) return;
    event.preventDefault();
    const rect = panel.current.getBoundingClientRect();
    setPosition(floatingPosition(area.current, rect.width, rect.height, rect.left + dx, rect.top + dy));
  }

  const grip = <div data-nav-grip="" title="Drag to a screen edge to dock, or into the workspace to float"
    className={cn('flex shrink-0 touch-none select-none items-center justify-center gap-2 rounded-md text-slate-500 hover:bg-slate-200/70 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white cursor-grab active:cursor-grabbing',
      floating ? 'min-h-10 flex-1 justify-start px-2 text-xs font-semibold' : horizontal ? 'size-10' : 'mx-1 min-h-6')}
    onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag}>
    <GripHorizontal className="size-4" aria-hidden="true" />{floating && 'Navigation'}
  </div>;

  const DockIcon = dockEdges.find(([side]) => side === edge)?.[1] ?? PanelLeft;
  const controls = <>
    {!floating && !horizontal && <button type="button" ref={floatButton} onClick={floatMenu} aria-label="Float menu" title="Float menu"
      className={cn(button, !collapsed && !horizontal && 'flex-1 justify-start')}>
      <PanelsTopLeft className="size-4" aria-hidden="true" />{!collapsed && !horizontal && 'Float menu'}
    </button>}
    <button ref={positionButton} type="button" aria-label="Dock position" title="Dock position" aria-haspopup="dialog" aria-expanded={choosingEdge}
      onClick={event => { event.currentTarget.focus(); setChoosingEdge(!choosingEdge); }}
      className={cn(button, floating && 'flex-1 justify-start')}>
      <DockIcon className="size-4" aria-hidden="true" />{floating && 'Dock position'}
    </button>
  </>;
  const verticalSidebar = <div className="min-h-0 flex-1 overflow-y-auto"><Sidebar floating={floating} placementControl={controls} /></div>;
  return <div className="fl-dock-space hidden md:block" ref={space}>
    {floating && <div className="pointer-events-auto absolute inset-y-0 left-0 flex w-12 justify-center border-r border-slate-200 bg-slate-50 pt-2 dark:border-slate-800 dark:bg-slate-900">
      <button ref={launcher} type="button" aria-label="Navigation menu" title="Navigation menu" aria-expanded={open} aria-controls={panelId}
        className={cn(button, 'h-fit w-10 flex-col gap-0.5 py-1.5 text-[10px] leading-4')} onClick={() => showPanel(!open)}>
        <Menu className="size-4" aria-hidden="true" />Menu
      </button>
    </div>}
    <div ref={area} className="fl-dock-float-area">
      <div ref={measure} aria-hidden="true" className="fl-dock-size invisible absolute" />
      {floating && <div ref={panel} id={panelId} hidden={!open} data-navigation-placement="floating" role="region" aria-label="Floating navigation"
        style={positionStyle(position)}
        className="fl-dock-panel fl-dock-size flex flex-col overflow-hidden rounded-xl border border-slate-300 bg-slate-50 shadow-2xl dark:border-slate-600 dark:bg-slate-900"
        onKeyDown={event => {
          if (event.key === 'Escape' && !choosingEdge && !drag.current && !event.defaultPrevented) {
            event.preventDefault(); event.stopPropagation(); showPanel(false);
          }
        }}>
        <div className="flex shrink-0 items-center gap-1 border-b border-slate-200 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-900">
          {grip}
          <button type="button" onClick={() => setPosition({ x: position.x < 0.5 ? 1 : 0, y: position.y })}
            onKeyDown={nudge} aria-describedby={panelId + '-move-help'} className={button}
            aria-label={position.x < 0.5 ? 'Move menu to right' : 'Move menu to left'} title="Switch sides or use the arrow keys to move">
            <ArrowLeftRight className="size-4" aria-hidden="true" />
          </button>
          <span id={panelId + '-move-help'} className="sr-only">Press Enter to switch sides or use the arrow keys to move the menu.</span>
          <button type="button" ref={closeButton} onClick={() => showPanel(false)} className={button} aria-label="Hide navigation" title="Hide navigation">
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
        {verticalSidebar}
      </div>}
    </div>
    {!floating && <div ref={panel} data-navigation-placement={edge} className="fl-dock-panel flex flex-col border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900">
      {horizontal ? <HorizontalNavigation edge={edge} controls={<>{grip}{controls}</>} /> : <>{grip}{verticalSidebar}</>}
    </div>}
    <Popover isOpen={choosingEdge} onClose={() => setChoosingEdge(false)} anchorRef={positionButton}
      placement={edge === 'top' && !floating ? 'bottom-end' : 'top-end'} ariaLabel="Dock position" className="grid w-44 gap-0.5 p-1.5">
      {dockEdges.map(([next, Icon]) => <button type="button" key={next} aria-pressed={!floating && edge === next}
        className={cn(button, 'justify-start')} onClick={() => dockMenu(next)}>
        <Icon className="size-4" aria-hidden="true" />Dock {next}{!floating && edge === next && <Check className="ml-auto size-4" aria-hidden="true" />}
      </button>)}
      {horizontal && <button type="button" className={cn(button, 'mt-1 justify-start border-t border-slate-200 dark:border-slate-700')} onClick={floatMenu}>
        <PanelsTopLeft className="size-4" aria-hidden="true" />Float menu
      </button>}
    </Popover>
    <div hidden ref={guide} aria-hidden="true" className="fl-dock-guide">
      <span ref={guideLabel} className="rounded-full bg-slate-900 px-3 py-1 text-xs font-semibold text-white shadow-lg dark:bg-white dark:text-slate-900" />
    </div>
  </div>;
}
