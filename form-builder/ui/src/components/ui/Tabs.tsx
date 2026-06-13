import React, { createContext, useContext, useId, useState } from 'react';
import { cn } from '../../lib/utils';

interface TabsContextValue {
  activeTab: string;
  setActiveTab: (value: string) => void;
  baseId: string;
}

const TabsContext = createContext<TabsContextValue | null>(null);

const tabId = (baseId: string, value: string) => `${baseId}-tab-${value}`;
const panelId = (baseId: string, value: string) => `${baseId}-panel-${value}`;

interface TabsProps {
  defaultValue?: string;
  value?: string;
  onValueChange?: (value: string) => void;
  children: React.ReactNode;
  className?: string;
}

export function Tabs({
  defaultValue = '',
  value,
  onValueChange,
  children,
  className,
}: TabsProps) {
  const [internalValue, setInternalValue] = useState(value ?? defaultValue);
  const baseId = useId();
  const activeTab = value ?? internalValue;

  const setActiveTab = (newValue: string) => {
    if (!value) {
      setInternalValue(newValue);
    }
    onValueChange?.(newValue);
  };

  return (
    <TabsContext.Provider value={{ activeTab, setActiveTab, baseId }}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  );
}

interface TabsListProps {
  children: React.ReactNode;
  className?: string;
  variant?: 'pills' | 'underline';
  'aria-label'?: string;
}


export function TabsList({ children, className, variant = 'pills', 'aria-label': ariaLabel }: TabsListProps) {
  // Roving focus: Arrow/Home/End move between tabs (automatic activation).
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const tabs = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([disabled])')
    );
    if (tabs.length === 0) return;
    const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
    let next = current;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = current < 0 ? 0 : (current + 1) % tabs.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = current < 0 ? tabs.length - 1 : (current - 1 + tabs.length) % tabs.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = tabs.length - 1;
        break;
    }
    e.preventDefault();
    const target = tabs[next];
    target.focus();
    target.click();
  };

  return (
    <div
      className={cn(
        'flex items-center overflow-x-auto',
        variant === 'pills' && 'gap-1 p-1 bg-gray-100/80 dark:bg-slate-800/80 rounded-lg',
        variant === 'underline' && 'gap-0 border-b border-gray-200 dark:border-slate-800',
        className
      )}
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      onKeyDown={handleKeyDown}
    >
      {children}
    </div>
  );
}

interface TabsTriggerProps {
  value: string;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
  variant?: 'pills' | 'underline';
}

export function TabsTrigger({
  value,
  children,
  className,
  disabled,
  variant = 'pills',
}: TabsTriggerProps) {
  const context = useContext(TabsContext);
  if (!context) throw new Error('TabsTrigger must be used within Tabs');

  const { activeTab, setActiveTab, baseId } = context;
  const isActive = activeTab === value;

  return (
    <button
      type="button"
      role="tab"
      id={tabId(baseId, value)}
      aria-selected={isActive}
      aria-controls={panelId(baseId, value)}
      onClick={() => !disabled && setActiveTab(value)}
      disabled={disabled}
      tabIndex={isActive ? 0 : -1}
      className={cn(
        'text-sm font-medium flex-shrink-0 whitespace-nowrap transition-all duration-200 cursor-pointer',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900',
        variant === 'pills' && [
          'px-3 py-1.5 rounded-md',
          isActive
            ? 'bg-white dark:bg-slate-700 text-gray-900 dark:text-white shadow-sm'
            : 'text-gray-600 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-50 dark:hover:bg-slate-700/50',
        ],
        variant === 'underline' && [
          'px-4 py-2.5 border-b-2 -mb-px',
          isActive
            ? 'border-primary-600 dark:border-primary-500 text-primary-700 dark:text-primary-400'
            : 'border-transparent text-gray-500 dark:text-slate-500 hover:text-gray-700 dark:hover:text-slate-300 hover:border-gray-300 dark:hover:border-slate-700',
        ],
        disabled && 'opacity-50 cursor-not-allowed',
        className
      )}
    >
      {children}
    </button>
  );
}

interface TabsContentProps {
  value: string;
  children: React.ReactNode;
  className?: string;
}

export function TabsContent({ value, children, className }: TabsContentProps) {
  const context = useContext(TabsContext);
  if (!context) throw new Error('TabsContent must be used within Tabs');

  if (context.activeTab !== value) return null;

  return (
    <div
      role="tabpanel"
      id={panelId(context.baseId, value)}
      aria-labelledby={tabId(context.baseId, value)}
      tabIndex={0}
      className={cn('focus:outline-none animate-in fade-in-0 duration-200', className)}
    >
      {children}
    </div>
  );
}
