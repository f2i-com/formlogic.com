import { Moon, Sun } from 'lucide-react';
import { useUIStore } from '../../stores/uiStore';
import { Button } from './Button';

export function ThemeToggle() {
    const { theme, toggleTheme } = useUIStore();

    return (
        <Button
            variant="ghost"
            size="sm"
            onClick={toggleTheme}
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
        >
            {theme === 'dark' ? (
                <Sun className="h-5 w-5 text-gray-400 group-hover:text-yellow-400 transition-colors" />
            ) : (
                <Moon className="h-5 w-5 text-gray-500 group-hover:text-slate-900 transition-colors" />
            )}
            <span className="sr-only">Toggle theme</span>
        </Button>
    );
}
