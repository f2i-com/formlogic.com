import {
  HelpCircle,
  Type,
  AlignLeft,
  Mail,
  Phone,
  Hash,
  Link,
  Calendar,
  Clock,
  CalendarClock,
  ChevronDown,
  CircleDot,
  CheckSquare,
  Star,
  Sliders,
  Paperclip,
  PenTool,
  CreditCard,
  Calculator,
  MessageSquare,
  PartyPopper,
  Heart,
} from 'lucide-react';

export const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  Type, AlignLeft, Mail, Phone, Hash, Link, Calendar, Clock, CalendarClock,
  ChevronDown, CircleDot, CheckSquare, Star, Sliders, Paperclip, PenTool,
  CreditCard, Calculator, MessageSquare, PartyPopper, Heart, HelpCircle
};
