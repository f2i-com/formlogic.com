import { icons } from 'lucide-react';

export function getLucideIcon(name: string): (typeof icons)[keyof typeof icons] | null {
  return (icons as Record<string, (typeof icons)[keyof typeof icons]>)[name] ?? null;
}

export const ICON_CATEGORIES: Record<string, string[]> = {
  General: [
    'FileText', 'File', 'Folder', 'Star', 'Heart', 'Flag', 'Bookmark', 'Tag',
    'Search', 'Home', 'Bell', 'Clock', 'Calendar', 'Map', 'Globe', 'Lock',
    'Unlock', 'Eye', 'EyeOff', 'Filter', 'List', 'Grid3X3', 'Layers', 'Layout',
  ],
  Business: [
    'Briefcase', 'Building', 'Building2', 'DollarSign', 'CreditCard', 'Receipt',
    'Wallet', 'TrendingUp', 'TrendingDown', 'BarChart3', 'PieChart', 'Target',
    'Award', 'Trophy', 'Handshake', 'Store', 'ShoppingCart', 'Package',
  ],
  People: [
    'User', 'Users', 'UserCheck', 'UserPlus', 'UserX', 'UserCog',
    'Contact', 'CircleUser', 'Baby', 'Accessibility',
  ],
  Communication: [
    'Mail', 'MessageSquare', 'MessageCircle', 'Phone', 'PhoneCall', 'Video',
    'Send', 'Inbox', 'AtSign', 'Megaphone', 'Radio', 'Rss',
  ],
  'Safety & Compliance': [
    'ShieldCheck', 'Shield', 'ShieldAlert', 'AlertTriangle', 'AlertCircle',
    'HardHat', 'Flame', 'Siren', 'BadgeCheck', 'Scale', 'Gavel',
    'ClipboardCheck', 'ClipboardList', 'FileCheck', 'FileWarning',
  ],
  Health: [
    'Activity', 'HeartPulse', 'Stethoscope', 'Pill', 'Thermometer',
    'Syringe', 'Cross', 'Hospital', 'Dna', 'Microscope',
  ],
  Tools: [
    'Wrench', 'Hammer', 'Settings', 'Cog', 'SlidersHorizontal', 'Gauge',
    'Zap', 'Plug', 'Cpu', 'Database', 'Server', 'Terminal', 'Code',
  ],
  Nature: [
    'Leaf', 'Cloud', 'Sun', 'Moon', 'Droplet', 'Mountain', 'TreePine',
    'Flower2', 'Bug', 'Fish', 'Bird', 'Waves',
  ],
  Education: [
    'GraduationCap', 'BookOpen', 'Library', 'PenTool', 'Pencil',
    'Ruler', 'Calculator', 'Lightbulb', 'School', 'Presentation',
  ],
  Transport: [
    'Car', 'Truck', 'Plane', 'Ship', 'Train', 'Bus', 'Bike',
    'Navigation', 'MapPin', 'Compass', 'Anchor', 'Rocket',
  ],
};
