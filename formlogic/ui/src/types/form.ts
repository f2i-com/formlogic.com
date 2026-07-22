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
  /** file_upload variant: 'camera' renders the in-form camera capture UI (photos
   *  are resized client-side before upload). Same answer shape as file_upload. */
  captureMode?: 'camera';
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
  // Related-records sub-grid (shown on the TARGET record's view, listing the records
  // that link here through this field). Defaults: shown, add + delete allowed,
  // 8 rows before the "Show all" expander.
  relatedHidden?: boolean;
  relatedAllowAdd?: boolean;
  relatedAllowDelete?: boolean;
  relatedPageSize?: number;
  /** Columns of the related sub-grid — fields of THIS form (the linking side). Absent = the
   *  target-label displayFieldIds double as columns (legacy), else the first simple fields. */
  relatedColumnFieldIds?: string[];
  // Match-based relation: also relate records whose `matchField` answer (on THIS form)
  // equals the target record's `targetMatchField` answer (defaults to matchField) — for
  // records written by flows/app logic that never know the target's record id.
  matchField?: string;
  targetMatchField?: string;
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
  /** Settings-style singleton: the form holds ONE record that users edit in place. In the app
   *  runtime, opening the form redirects to that record in edit mode (the blank form only shows
   *  until the first record exists). UX-level — the server doesn't reject extra rows. */
  singleRecord?: boolean;
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
  /** Server-derived provenance gate. Client-authored values are stripped on save. */
  _trust?: 'owner' | 'verified' | 'untrusted';
  _provenance?: Record<string, unknown>;
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
  /** Screen mode: 'code' = sandboxed HTML/CSS/JS (default), 'dashboard' = host-rendered widget grid,
   *  'sdk' = host-rendered first-party React screen from the trusted registry. */
  kind?: 'code' | 'dashboard' | 'sdk';
  /** Declarative widget dashboard (host-rendered recharts). Present when kind === 'dashboard'. */
  dashboard?: DashboardScreen;
  /** Host-rendered first-party React screen (SDK). Present when kind === 'sdk'. */
  sdkScreen?: { screenId: string; title?: string; params?: Record<string, unknown> };
  /** Optional per-RECORD widget on the record detail view (independent of the section screen):
   *  'sdk' renders a trusted registry screen with the record context; 'code' renders sandboxed
   *  HTML/CSS/JS whose SDK additionally exposes FormLogic.record() and FormLogic.related(). */
  recordScreen?: RecordScreen;
}

export interface RecordScreen {
  kind: 'sdk' | 'code';
  title?: string;
  /** sdk: id of a registered first-party screen (sdkScreenRegistry). */
  screenId?: string;
  params?: Record<string, unknown>;
  /** linked_record field ids whose related groups this screen renders itself — the generic
   *  Related-records panel hides them so the data isn't shown twice. */
  consumesRelated?: string[];
  /** code: sandboxed sources (same contract as section code screens). */
  html?: string;
  css?: string;
  js?: string;
  ts?: string;
  files?: Array<{ path: string; content: string }>;
  entry?: string;
  /** Iframe height for code screens (px, default 420, clamped 160–1200). */
  height?: number;
}

/**
 * The signed encryption manifest served on a PRIVATE form by
 * GET /api/public/forms/{id} (E2EE plan SS8 - pinned wire contract). Presence of
 * this object (mode 'private') switches the submit path to client-side sealing;
 * it must NEVER silently fall back to plaintext.
 */
export interface PublicFormEncryption {
  mode: 'private';
  keyId: string;
  epoch: number;
  /** Base64 32-byte ingestion X25519 public key. */
  publicKey: string;
  content: string;
  wrap: string;
  schemaVersion: number;
  /** SHA-256 hex of the EXACT schemaJson bytes. */
  schemaHash: string;
  /** The exact stored schema snapshot string that was hashed. */
  schemaJson: string;
  signerKeyId: string;
  /** Base64 32-byte Ed25519 manifest verification key (TOFU-pinned per form). */
  signerPk: string;
  expiresAt: string | null;
  /** Base64 Ed25519 signature over the pinned canonical manifest string. */
  sig: string;
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
  /** Optional form-scoped sandboxed QuickJS app-logic (runs only when this form is open). */
  customLogic?: import('./customAppLogic').CustomAppLogicBundle;
  /** Present (mode 'private') when this form is end-to-end encrypted (E2EE plan SS8). */
  encryption?: PublicFormEncryption;
  icon?: string;
  createdAt: string;
  updatedAt: string;
  status: 'draft' | 'published' | 'archived';
  responseCount: number;
  /** Durable first-publish timestamp (§9.1): private forms can only be enabled while null. */
  everPublishedAt?: string | null;
  /** Served on the forms-list payload (E2EE): true when the form is end-to-end encrypted. */
  isPrivate?: boolean;
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

/**
 * Legacy field-type aliases from older/imported schemas, mapped onto the canonical
 * types above (the backend normalizes on read/write too — FormService::normalizeFieldType).
 * Without this, a legacy `text`/`textarea` field hits the renderer's default case
 * ("Field type not supported").
 */
export const FIELD_TYPE_ALIASES: Record<string, FieldType> = {
  text: 'short_text',
  textarea: 'long_text',
};

export function normalizeFieldType(type: string): FieldType {
  return FIELD_TYPE_ALIASES[type] ?? (type as FieldType);
}

// Stored settings predate newer keys for most forms (and can even be `[]`), so consumers
// that edit settings should seed over the defaults — otherwise e.g. reading
// `notifications.emailNotifications` throws on forms whose settings never had a
// `notifications` object (the builder Settings → Notifications crash).
export function normalizeFormSettings(settings: FormSettings): FormSettings {
  const base = (settings ?? {}) as Partial<FormSettings>;
  return {
    ...DEFAULT_FORM_SETTINGS,
    ...base,
    notifications: { ...DEFAULT_FORM_SETTINGS.notifications, ...(base.notifications ?? {}) },
  };
}
