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
  | 'payment'
  | 'statement'
  | 'welcome_screen'
  | 'thank_you'
  | 'calculated'
  | 'linked_record';

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
  acceptedFileTypes?: string[];
  currency?: string;
  calculationExpression?: string;
  mediaUrl?: string;
  mediaType?: 'image' | 'video';
  buttonText?: string;
  // Linked record properties
  targetFormId?: string;
  displayFieldIds?: string[];
  searchFieldIds?: string[];
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
  createdAt: string;
  updatedAt: string;
  status: 'draft' | 'published' | 'archived';
  responseCount: number;
}

export interface FormResponse {
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
  primaryColor: '#6366f1',
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
  payment: { label: 'Payment', icon: 'CreditCard', category: 'advanced' },
  calculated: { label: 'Calculated', icon: 'Calculator', category: 'advanced' },
  linked_record: { label: 'Linked Record', icon: 'Link2', category: 'advanced' },
  statement: { label: 'Statement', icon: 'MessageSquare', category: 'layout' },
  welcome_screen: { label: 'Welcome Screen', icon: 'PartyPopper', category: 'layout' },
  thank_you: { label: 'Thank You', icon: 'Heart', category: 'layout' },
};
