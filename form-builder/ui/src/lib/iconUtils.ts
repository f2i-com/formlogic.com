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
  PawPrint, Dog, Cat, Bone, Footprints,
  Coffee, CupSoda, Milk, ChefHat, Utensils, UtensilsCrossed, Beef, Sandwich,
  Salad, Soup, CookingPot, Croissant, ConciergeBell,
  Warehouse, Boxes, PackageOpen, Barcode, Banknote,
  BedDouble, KeyRound, DoorOpen, Luggage, Armchair, Bath, WashingMachine,
  ShowerHead, Sparkles, SprayCan,
  Smartphone, Laptop, CircuitBoard, BatteryCharging,
  Dumbbell, Tractor, Wheat, Sprout, Fuel, Construction, Route,
  Timer, ListChecks, CalendarClock, CalendarCheck, NotebookPen, ClipboardPen,
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
  PawPrint, Dog, Cat, Bone, Footprints,
  Coffee, CupSoda, Milk, ChefHat, Utensils, UtensilsCrossed, Beef, Sandwich,
  Salad, Soup, CookingPot, Croissant, ConciergeBell,
  Warehouse, Boxes, PackageOpen, Barcode, Banknote,
  BedDouble, KeyRound, DoorOpen, Luggage, Armchair, Bath, WashingMachine,
  ShowerHead, Sparkles, SprayCan,
  Smartphone, Laptop, CircuitBoard, BatteryCharging,
  Dumbbell, Tractor, Wheat, Sprout, Fuel, Construction, Route,
  Timer, ListChecks, CalendarClock, CalendarCheck, NotebookPen, ClipboardPen,
};

export function getLucideIcon(name: string): LucideIcon | null {
  return ICON_MAP[name] ?? null;
}

export const ICON_CATEGORIES: Record<string, string[]> = {
  General: [
    'FileText', 'File', 'Folder', 'Star', 'Heart', 'Flag', 'Bookmark', 'Tag',
    'Search', 'Home', 'Bell', 'Clock', 'Calendar', 'Map', 'Globe', 'Lock',
    'Unlock', 'Eye', 'EyeOff', 'Filter', 'List', 'Grid3X3', 'Layers', 'Layout',
    'LayoutGrid', 'CalendarDays', 'Newspaper', 'PartyPopper', 'ListChecks',
    'Timer', 'CalendarClock', 'CalendarCheck', 'Sparkles', 'KeyRound', 'DoorOpen',
  ],
  Business: [
    'Briefcase', 'Building', 'Building2', 'DollarSign', 'CreditCard', 'Receipt',
    'Wallet', 'TrendingUp', 'TrendingDown', 'BarChart3', 'PieChart', 'Target',
    'Award', 'Trophy', 'Handshake', 'Store', 'ShoppingCart', 'Package', 'Ticket',
    'Banknote', 'Barcode', 'Boxes', 'PackageOpen', 'Warehouse', 'ConciergeBell',
  ],
  'Food & Hospitality': [
    'Coffee', 'CupSoda', 'Milk', 'ChefHat', 'Utensils', 'UtensilsCrossed',
    'Beef', 'Sandwich', 'Salad', 'Soup', 'CookingPot', 'Croissant', 'BedDouble',
    'Luggage', 'Armchair', 'Bath',
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
    'Syringe', 'Cross', 'Hospital', 'Dna', 'Microscope', 'Dumbbell',
  ],
  Tools: [
    'Wrench', 'Hammer', 'Scissors', 'Settings', 'Cog', 'SlidersHorizontal', 'Gauge',
    'Zap', 'Plug', 'Cpu', 'Database', 'Server', 'Terminal', 'Code', 'RotateCcw',
    'SprayCan', 'CircuitBoard', 'BatteryCharging', 'Smartphone', 'Laptop',
    'WashingMachine', 'ShowerHead', 'Construction',
  ],
  Nature: [
    'Leaf', 'Cloud', 'Sun', 'Moon', 'Droplet', 'Mountain', 'TreePine',
    'Flower2', 'Bug', 'Fish', 'Bird', 'Waves', 'PawPrint', 'Dog', 'Cat',
    'Bone', 'Footprints', 'Tractor', 'Wheat', 'Sprout',
  ],
  Education: [
    'GraduationCap', 'BookOpen', 'Library', 'PenTool', 'Pencil',
    'Ruler', 'Calculator', 'Lightbulb', 'School', 'Presentation',
    'NotebookPen', 'ClipboardPen',
  ],
  Transport: [
    'Car', 'Truck', 'Plane', 'Ship', 'Train', 'Bus', 'Bike',
    'Navigation', 'MapPin', 'Compass', 'Anchor', 'Rocket', 'Fuel', 'Route',
  ],
};
