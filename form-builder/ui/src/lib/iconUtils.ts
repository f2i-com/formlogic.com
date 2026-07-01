import type { LucideIcon } from 'lucide-react';
import {
  FileText, File, Folder, Star, Heart, Flag, Bookmark, Tag, Search, Home, Bell,
  Clock, Calendar, Map, Globe, Lock, Unlock, Eye, EyeOff, Filter, List, Grid3X3,
  Layers, Layout,
  Briefcase, Building, Building2, DollarSign, CreditCard, Receipt, Wallet,
  TrendingUp, TrendingDown, BarChart3, PieChart, Target, Award, Trophy, Handshake,
  Store, ShoppingCart, Package,
  User, Users, UserCheck, UserPlus, UserX, UserCog, Contact, CircleUser, Baby,
  Accessibility,
  Mail, MessageSquare, MessageCircle, Phone, PhoneCall, Video, Send, Inbox, AtSign,
  Megaphone, Radio, Rss,
  ShieldCheck, Shield, ShieldAlert, AlertTriangle, AlertCircle, HardHat, Flame,
  Siren, BadgeCheck, Scale, Gavel, ClipboardCheck, ClipboardList, FileCheck,
  FileWarning,
  Activity, HeartPulse, Stethoscope, Pill, Thermometer, Syringe, Cross, Hospital,
  Dna, Microscope,
  Wrench, Hammer, Settings, Cog, SlidersHorizontal, Gauge, Zap, Plug, Cpu, Database,
  Server, Terminal, Code,
  Leaf, Cloud, Sun, Moon, Droplet, Mountain, TreePine, Flower2, Bug, Fish, Bird,
  Waves,
  GraduationCap, BookOpen, Library, PenTool, Pencil, Ruler, Calculator, Lightbulb,
  School, Presentation,
  Car, Truck, Plane, Ship, Train, Bus, Bike, Navigation, MapPin, Compass, Anchor,
  Rocket,
  // Names used by bundled packs' form/app icons (must be here or DynamicIcon falls
  // back to the generic FileText for those forms).
  ArrowUpCircle, CalendarDays, HandHelping, LayoutGrid, LifeBuoy, LogOut, Mic,
  Newspaper, PartyPopper, RotateCcw, Scissors, Ticket,
} from 'lucide-react';

// Explicit icon map. Importing lucide's `{ icons }` barrel and looking up by
// string defeated tree-shaking, so the ENTIRE ~1,500-icon set (a ~486 KB chunk)
// shipped to every signed-in user even though only the ~136 names below are ever
// offered in the picker. Statically importing exactly those folds them into the
// component chunks and drops the standalone icons chunk.
const ICON_MAP: Record<string, LucideIcon> = {
  FileText, File, Folder, Star, Heart, Flag, Bookmark, Tag, Search, Home, Bell,
  Clock, Calendar, Map, Globe, Lock, Unlock, Eye, EyeOff, Filter, List, Grid3X3,
  Layers, Layout,
  Briefcase, Building, Building2, DollarSign, CreditCard, Receipt, Wallet,
  TrendingUp, TrendingDown, BarChart3, PieChart, Target, Award, Trophy, Handshake,
  Store, ShoppingCart, Package,
  User, Users, UserCheck, UserPlus, UserX, UserCog, Contact, CircleUser, Baby,
  Accessibility,
  Mail, MessageSquare, MessageCircle, Phone, PhoneCall, Video, Send, Inbox, AtSign,
  Megaphone, Radio, Rss,
  ShieldCheck, Shield, ShieldAlert, AlertTriangle, AlertCircle, HardHat, Flame,
  Siren, BadgeCheck, Scale, Gavel, ClipboardCheck, ClipboardList, FileCheck,
  FileWarning,
  Activity, HeartPulse, Stethoscope, Pill, Thermometer, Syringe, Cross, Hospital,
  Dna, Microscope,
  Wrench, Hammer, Settings, Cog, SlidersHorizontal, Gauge, Zap, Plug, Cpu, Database,
  Server, Terminal, Code,
  Leaf, Cloud, Sun, Moon, Droplet, Mountain, TreePine, Flower2, Bug, Fish, Bird,
  Waves,
  GraduationCap, BookOpen, Library, PenTool, Pencil, Ruler, Calculator, Lightbulb,
  School, Presentation,
  Car, Truck, Plane, Ship, Train, Bus, Bike, Navigation, MapPin, Compass, Anchor,
  Rocket,
  ArrowUpCircle, CalendarDays, HandHelping, LayoutGrid, LifeBuoy, LogOut, Mic,
  Newspaper, PartyPopper, RotateCcw, Scissors, Ticket,
};

export function getLucideIcon(name: string): LucideIcon | null {
  return ICON_MAP[name] ?? null;
}

export const ICON_CATEGORIES: Record<string, string[]> = {
  General: [
    'FileText', 'File', 'Folder', 'Star', 'Heart', 'Flag', 'Bookmark', 'Tag',
    'Search', 'Home', 'Bell', 'Clock', 'Calendar', 'Map', 'Globe', 'Lock',
    'Unlock', 'Eye', 'EyeOff', 'Filter', 'List', 'Grid3X3', 'Layers', 'Layout',
    'LayoutGrid', 'CalendarDays', 'Newspaper', 'PartyPopper',
  ],
  Business: [
    'Briefcase', 'Building', 'Building2', 'DollarSign', 'CreditCard', 'Receipt',
    'Wallet', 'TrendingUp', 'TrendingDown', 'BarChart3', 'PieChart', 'Target',
    'Award', 'Trophy', 'Handshake', 'Store', 'ShoppingCart', 'Package', 'Ticket',
  ],
  People: [
    'User', 'Users', 'UserCheck', 'UserPlus', 'UserX', 'UserCog',
    'Contact', 'CircleUser', 'Baby', 'Accessibility', 'HandHelping', 'LogOut',
  ],
  Communication: [
    'Mail', 'MessageSquare', 'MessageCircle', 'Phone', 'PhoneCall', 'Video',
    'Send', 'Inbox', 'AtSign', 'Megaphone', 'Radio', 'Rss', 'Mic',
  ],
  'Safety & Compliance': [
    'ShieldCheck', 'Shield', 'ShieldAlert', 'AlertTriangle', 'AlertCircle',
    'HardHat', 'Flame', 'Siren', 'BadgeCheck', 'Scale', 'Gavel',
    'ClipboardCheck', 'ClipboardList', 'FileCheck', 'FileWarning', 'LifeBuoy', 'ArrowUpCircle',
  ],
  Health: [
    'Activity', 'HeartPulse', 'Stethoscope', 'Pill', 'Thermometer',
    'Syringe', 'Cross', 'Hospital', 'Dna', 'Microscope',
  ],
  Tools: [
    'Wrench', 'Hammer', 'Scissors', 'Settings', 'Cog', 'SlidersHorizontal', 'Gauge',
    'Zap', 'Plug', 'Cpu', 'Database', 'Server', 'Terminal', 'Code', 'RotateCcw',
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
