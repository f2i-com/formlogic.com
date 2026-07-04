import type { DashboardScreen } from './app';

export type FieldType =
  | 'short_text'
  | 'long_text'
  | 'email'
  | 'phone'
  | 'number'
  | 'url'
  | 'date'
  | 'time'
  | 'datetime'
  | 'dropdown'
  | 'multiple_choice'
  | 'checkboxes'
  | 'rating'
  | 'scale'
  | 'file_upload'
  | 'signature'
  | 'statement'
  | 'welcome_screen'
  | 'thank_you'
  | 'calculated'
  | 'linked_record'
  | 'location'
  | 'hidden';

export interface FieldOption {
  id: string;
  label: string;
  value: string;
}

export interface ValidationRule {
  id: string;
  type: 'required' | 'minLength' | 'maxLength' | 'min' | 'max' | 'pattern' | 'custom';
  value?: string | number;
  message: string;
  expression?: string;
}

export interface ConditionalLogic {
  expression: string;
  action: 'show' | 'hide' | 'skip' | 'require';
}

export interface FieldProperties {
  options?: FieldOption[];
  min?: number;
  max?: number;
  step?: number;
  maxStars?: number;
  scaleStart?: number;
  scaleEnd?: number;
  scaleStartLabel?: string;
  scaleEndLabel?: string;
  allowMultiple?: boolean;
  maxFileSize?: number;
  maxFiles?: number;
  acceptedFileTypes?: string[];
  calculationExpression?: string;
  // Static value seeded into a hidden field (used when there's no calculationExpression).
  defaultValue?: string;
  mediaUrl?: string;
  mediaType?: 'image' | 'video';
  mediaAlt?: string;
  buttonText?: string;
  // Linked record properties
  targetFormId?: string;
  displayFieldIds?: string[];
  searchFieldIds?: string[];
  // Location properties
  showMap?: boolean;
}

export interface FormField {
  id: string;
  type: FieldType;
  label: string;
  description?: string;
  placeholder?: string;
  required: boolean;
  validation?: ValidationRule[];
  properties: FieldProperties;
  conditionalLogic?: ConditionalLogic;
  order: number;
}

export interface NotificationSettings {
  emailNotifications: boolean;
  notificationEmail?: string;
}

export interface FormSettings {
  presentationMode: 'focused' | 'classic' | 'both';
  defaultPresentationMode: 'focused' | 'classic';
  showProgressBar: boolean;
  allowBackNavigation: boolean;
  submitButtonText: string;
  redirectUrl?: string;
  notifications: NotificationSettings;
  quotaLimit?: number;
  closedMessage?: string;
  isClosed: boolean;
  showNigoDashboard?: boolean;
}

export interface FormTheme {
  primaryColor: string;
  backgroundColor: string;
  textColor: string;
  fontFamily: string;
  borderRadius: 'none' | 'small' | 'medium' | 'large';
  backgroundImage?: string;
  logo?: string;
}

export interface CustomScreen {
  enabled?: boolean;
  html?: string;
  css?: string;
  /** Compiled, runnable JS (the artifact the sandbox executes). Produced from `ts`/`files` on save. */
  js?: string;
  /** TypeScript/JS source authored in the editor (single-file mode). Compiled to `js`. */
  ts?: string;
  /** Multi-file project: TS/TSX/CSS/HTML files with relative imports, bundled to `js` (index.html = shell). */
  files?: Array<{ path: string; content: string }>;
  /** Entry file for the multi-file bundle (default: index.ts / index.tsx). */
  entry?: string;
  /** When true, the screen's records() works on the public link (e.g. a leaderboard). */
  publicRecords?: boolean;
  /** Whitelist of field ids exposed publicly via records() — ONLY these answer keys are returned. */
  publicRecordFields?: string[];
  /** When true, viewers can still open the real form while the screen is shown — the runtime
   *  overlays a "New record" button and the screen may call FormLogic.openForm(). */
  allowNewResponses?: boolean;
  /** Screen mode: 'code' = sandboxed HTML/CSS/JS (default), 'dashboard' = host-rendered widget grid. */
  kind?: 'code' | 'dashboard';
  /** Declarative widget dashboard (host-rendered recharts). Present when kind === 'dashboard'. */
  dashboard?: DashboardScreen;
}

export interface Form {
  id: string;
  title: string;
  description?: string;
  fields: FormField[];
  fieldCount?: number;
  settings: FormSettings;
  theme: FormTheme;
  logicScript?: string;
  logicPrompt?: string;
  /** Optional sandboxed custom frontend ({ html, css, js }) over this form's data. */
  customScreen?: CustomScreen;
  icon?: string;
  createdAt: string;
  updatedAt: string;
  status: 'draft' | 'published' | 'archived';
  responseCount: number;
}

/**
 * LocalFormResponse is used by responseStore for client-side/offline storage.
 * It intentionally includes extra fields (formId, completionTime at top level)
 * that the API response (FormResponse in lib/api.ts) structures differently.
 * The API version puts completionTime inside metadata and includes status.
 */
export interface LocalFormResponse {
  id: string;
  formId: string;
  answers: Record<string, unknown>;
  submittedAt: string;
  completionTime: number;
  metadata: {
    userAgent?: string;
    referrer?: string;
  };
}

export const DEFAULT_FORM_SETTINGS: FormSettings = {
  presentationMode: 'both',
  defaultPresentationMode: 'focused',
  showProgressBar: true,
  allowBackNavigation: true,
  submitButtonText: 'Submit',
  notifications: {
    emailNotifications: false,
  },
  isClosed: false,
};

export const DEFAULT_FORM_THEME: FormTheme = {
  primaryColor: '#4f46e5',
  backgroundColor: '#ffffff',
  textColor: '#1f2937',
  fontFamily: 'Inter',
  borderRadius: 'medium',
};

export const FIELD_TYPE_INFO: Record<FieldType, { label: string; icon: string; category: string }> = {
  short_text: { label: 'Short Text', icon: 'Type', category: 'text' },
  long_text: { label: 'Long Text', icon: 'AlignLeft', category: 'text' },
  email: { label: 'Email', icon: 'Mail', category: 'text' },
  phone: { label: 'Phone', icon: 'Phone', category: 'text' },
  number: { label: 'Number', icon: 'Hash', category: 'text' },
  url: { label: 'URL', icon: 'Link', category: 'text' },
  date: { label: 'Date', icon: 'Calendar', category: 'datetime' },
  time: { label: 'Time', icon: 'Clock', category: 'datetime' },
  datetime: { label: 'Date & Time', icon: 'CalendarClock', category: 'datetime' },
  dropdown: { label: 'Dropdown', icon: 'ChevronDown', category: 'choice' },
  multiple_choice: { label: 'Multiple Choice', icon: 'CircleDot', category: 'choice' },
  checkboxes: { label: 'Checkboxes', icon: 'CheckSquare', category: 'choice' },
  rating: { label: 'Rating', icon: 'Star', category: 'rating' },
  scale: { label: 'Scale', icon: 'Sliders', category: 'rating' },
  file_upload: { label: 'File Upload', icon: 'Paperclip', category: 'advanced' },
  signature: { label: 'Signature', icon: 'PenTool', category: 'advanced' },
  calculated: { label: 'Calculated', icon: 'Calculator', category: 'advanced' },
  linked_record: { label: 'Linked Record', icon: 'Link2', category: 'advanced' },
  statement: { label: 'Statement', icon: 'MessageSquare', category: 'layout' },
  location: { label: 'Location', icon: 'MapPin', category: 'advanced' },
  welcome_screen: { label: 'Welcome Screen', icon: 'PartyPopper', category: 'layout' },
  thank_you: { label: 'Thank You', icon: 'Heart', category: 'layout' },
  hidden: { label: 'Hidden Field', icon: 'EyeOff', category: 'advanced' },
};
