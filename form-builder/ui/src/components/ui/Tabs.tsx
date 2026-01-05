import React, { createContext, useContext, useState } from 'react';
import { cn } from '../../lib/utils';

interface TabsContextValue {
  activeTab: string;
  setActiveTab: (value: string) => void;
}

const TabsContext = createContext<TabsContextValue | null>(null);

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
  const activeTab = value ?? internalValue;

  const setActiveTab = (newValue: string) => {
    if (!value) {
      setInternalValue(newValue);
    }
    onValueChange?.(newValue);
  };

  return (
    <TabsContext.Provider value={{ activeTab, setActiveTab }}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  );
}

interface TabsListProps {
  children: React.ReactNode;
  className?: string;
  variant?: 'pills' | 'underline';
}

export function TabsList({ children, className, variant = 'pills' }: TabsListProps) {
  return (
    <div
      className={cn(
        'flex items-center overflow-x-auto',
        variant === 'pills' && 'gap-1 p-1 bg-gray-100/80 rounded-lg',
        variant === 'underline' && 'gap-0 border-b border-gray-200',
        className
      )}
      role="tablist"
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

  const { activeTab, setActiveTab } = context;
  const isActive = activeTab === value;

  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      onClick={() => !disabled && setActiveTab(value)}
      disabled={disabled}
      className={cn(
        'text-sm font-medium flex-shrink-0 whitespace-nowrap transition-all duration-200',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2',
        variant === 'pills' && [
          'px-3 py-1.5 rounded-md',
          isActive
            ? 'bg-white text-gray-900 shadow-sm'
            : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50',
        ],
        variant === 'underline' && [
          'px-4 py-2.5 border-b-2 -mb-px',
          isActive
            ? 'border-primary-600 text-primary-700'
            : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300',
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
    <div role="tabpanel" className={cn('animate-in fade-in-0 duration-200', className)}>
      {children}
    </div>
  );
}
