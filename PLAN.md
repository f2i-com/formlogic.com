# FormLogic Form Builder - Implementation Plan

A Typeform-like form builder with React, TypeScript, Tailwind CSS, and Vite.
Uses the FormLogic scripting engine for conditional logic, validation, and calculations.

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Technology Stack](#technology-stack)
3. [Architecture Overview](#architecture-overview)
4. [Data Models](#data-models)
5. [ASCII Storyboards](#ascii-storyboards)
6. [Component Structure](#component-structure)
7. [Feature Breakdown](#feature-breakdown)
8. [FormLogic Integration](#formlogic-integration)
9. [Implementation Phases](#implementation-phases)

---

## Project Overview

### Goals
- Create a modern, mobile-friendly form builder similar to Typeform
- Support full suite of field types including conditional logic
- Two presentation modes: One-question-at-a-time & Scrollable
- Live preview panel + Full-screen preview mode
- Frontend-only with JSON schema export
- Leverage FormLogic engine for scripting/conditional logic

### Key Features
- Drag-and-drop form builder interface
- 15+ field types (text, email, rating, file upload, signature, etc.)
- Conditional logic powered by FormLogic scripting
- Field validation with custom expressions
- Calculated fields
- Theme customization
- Mobile-responsive forms
- Form analytics dashboard (mock data)
- JSON import/export

---

## Technology Stack

```
┌─────────────────────────────────────────────────────────────┐
│                      FRONTEND STACK                         │
├─────────────────────────────────────────────────────────────┤
│  Framework:     React 18 + TypeScript                       │
│  Build Tool:    Vite                                        │
│  Styling:       Tailwind CSS                                │
│  State:         Zustand (lightweight, TypeScript-friendly)  │
│  Drag & Drop:   @dnd-kit/core                               │
│  Routing:       React Router v6                             │
│  Icons:         Lucide React                                │
│  Animations:    Framer Motion                               │
│  Forms:         React Hook Form (for builder UI)            │
│  Logic Engine:  formlogic-typescript (local package)        │
│  Storage:       LocalStorage + IndexedDB (for forms/files)  │
│  Testing:       Vitest + React Testing Library              │
└─────────────────────────────────────────────────────────────┘
```

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                           APPLICATION ARCHITECTURE                        │
└──────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                              APP SHELL                                   │
│  ┌─────────────┐  ┌──────────────────────────────────────────────────┐  │
│  │   Sidebar   │  │                   Main Content                    │  │
│  │  Navigation │  │                                                   │  │
│  │             │  │  ┌────────────────────────────────────────────┐  │  │
│  │  - Dashboard│  │  │              ROUTE VIEWS                   │  │  │
│  │  - Forms    │  │  │                                            │  │  │
│  │  - Builder  │  │  │  /dashboard    → Dashboard View            │  │  │
│  │  - Settings │  │  │  /forms        → Forms List View           │  │  │
│  │             │  │  │  /builder/:id  → Form Builder View         │  │  │
│  │             │  │  │  /preview/:id  → Form Preview View         │  │  │
│  │             │  │  │  /respond/:id  → Public Form Response      │  │  │
│  │             │  │  │  /analytics/:id→ Form Analytics View       │  │  │
│  └─────────────┘  │  └────────────────────────────────────────────┘  │  │
│                   └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                           STATE MANAGEMENT                               │
│                                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐  │
│  │  formStore   │  │  uiStore     │  │ responseStore│  │ themeStore  │  │
│  │              │  │              │  │              │  │             │  │
│  │ - forms[]   │  │ - sidebar    │  │ - responses  │  │ - colors    │  │
│  │ - activeForm│  │ - modal      │  │ - current    │  │ - fonts     │  │
│  │ - fields[]  │  │ - preview    │  │ - validation │  │ - branding  │  │
│  │ - settings  │  │ - device     │  │ - progress   │  │             │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  └─────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                         FORMLOGIC ENGINE                                 │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                    FormLogic Integration Layer                   │    │
│  │                                                                  │    │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │    │
│  │  │ Conditional │  │ Validation  │  │    Calculated Fields    │  │    │
│  │  │   Logic     │  │   Engine    │  │                         │  │    │
│  │  │             │  │             │  │  field.price * quantity │  │    │
│  │  │ age > 18 && │  │ email.match │  │  = total                │  │    │
│  │  │ country=US  │  │ (/regex/)   │  │                         │  │    │
│  │  └─────────────┘  └─────────────┘  └─────────────────────────┘  │    │
│  │                                                                  │    │
│  │  Custom Modules: validators, formatters, api (mock)             │    │
│  └─────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Data Models

### Form Schema

```typescript
interface Form {
  id: string;
  title: string;
  description?: string;
  fields: FormField[];
  settings: FormSettings;
  theme: FormTheme;
  logic: FormLogic[];
  createdAt: Date;
  updatedAt: Date;
  status: 'draft' | 'published' | 'archived';
}

interface FormField {
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

type FieldType =
  | 'short_text'      // Single line text
  | 'long_text'       // Multi-line textarea
  | 'email'           // Email with validation
  | 'phone'           // Phone number
  | 'number'          // Numeric input
  | 'url'             // URL input
  | 'date'            // Date picker
  | 'time'            // Time picker
  | 'datetime'        // Date + Time
  | 'dropdown'        // Select dropdown
  | 'multiple_choice' // Radio buttons
  | 'checkboxes'      // Multiple selection
  | 'rating'          // Star/emoji rating
  | 'scale'           // Linear scale (1-10)
  | 'file_upload'     // File attachment
  | 'signature'       // Signature pad
  | 'payment'         // Payment field (mock)
  | 'statement'       // Text/media statement
  | 'welcome_screen'  // Welcome page
  | 'thank_you'       // End screen
  | 'calculated';     // Calculated field

interface FormSettings {
  presentationMode: 'typeform' | 'classic' | 'both';
  showProgressBar: boolean;
  allowBackNavigation: boolean;
  submitButtonText: string;
  redirectUrl?: string;
  notifications: NotificationSettings;
  quotaLimit?: number;
}

interface FormTheme {
  primaryColor: string;
  backgroundColor: string;
  textColor: string;
  fontFamily: string;
  borderRadius: 'none' | 'small' | 'medium' | 'large';
  backgroundImage?: string;
  logo?: string;
}

interface ConditionalLogic {
  // FormLogic expression that returns boolean
  expression: string;
  // What to do when expression is true
  action: 'show' | 'hide' | 'skip' | 'require';
}

interface ValidationRule {
  type: 'required' | 'minLength' | 'maxLength' | 'pattern' | 'custom';
  value?: string | number;
  message: string;
  // For custom validation, FormLogic expression
  expression?: string;
}
```

---

## ASCII Storyboards

### 1. Dashboard View (Desktop)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  ┌─────┐  FormLogic                              🔔  👤 John Doe  ▼         │
│  │ FL  │                                                                     │
├──┴─────┴─────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌────────────┐  ┌───────────────────────────────────────────────────────┐  │
│  │            │  │                                                        │  │
│  │  📊        │  │   Welcome back, John!                                 │  │
│  │  Dashboard │  │                                                        │  │
│  │  ────────  │  │   ┌──────────────┐ ┌──────────────┐ ┌──────────────┐  │  │
│  │            │  │   │   📝 12      │ │   👁️ 1,234   │ │   ✅ 89%     │  │  │
│  │  📋        │  │   │   Forms      │ │   Views      │ │   Completion │  │  │
│  │  My Forms  │  │   │   Total      │ │   This Month │ │   Rate       │  │  │
│  │            │  │   └──────────────┘ └──────────────┘ └──────────────┘  │  │
│  │  ➕        │  │                                                        │  │
│  │  Create    │  │   Recent Forms                          [+ New Form]  │  │
│  │            │  │   ─────────────────────────────────────────────────── │  │
│  │  ⚙️        │  │                                                        │  │
│  │  Settings  │  │   ┌────────────────────────────────────────────────┐  │  │
│  │            │  │   │  📋 Customer Feedback Survey                   │  │  │
│  │            │  │   │  Updated 2 hours ago  •  156 responses         │  │  │
│  │            │  │   │  [Edit] [Preview] [Analytics] [Share] [···]   │  │  │
│  │            │  │   └────────────────────────────────────────────────┘  │  │
│  │            │  │                                                        │  │
│  │            │  │   ┌────────────────────────────────────────────────┐  │  │
│  │            │  │   │  📋 Job Application Form                       │  │  │
│  │            │  │   │  Updated yesterday  •  42 responses            │  │  │
│  │            │  │   │  [Edit] [Preview] [Analytics] [Share] [···]   │  │  │
│  │            │  │   └────────────────────────────────────────────────┘  │  │
│  │            │  │                                                        │  │
│  │            │  │   ┌────────────────────────────────────────────────┐  │  │
│  │            │  │   │  📋 Event Registration       DRAFT             │  │  │
│  │            │  │   │  Updated 3 days ago  •  0 responses            │  │  │
│  │            │  │   │  [Edit] [Preview] [Analytics] [Share] [···]   │  │  │
│  │            │  │   └────────────────────────────────────────────────┘  │  │
│  │            │  │                                                        │  │
│  └────────────┘  └───────────────────────────────────────────────────────┘  │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 2. Dashboard View (Mobile)

```
┌─────────────────────────────┐
│  ☰  FormLogic        🔔 👤 │
├─────────────────────────────┤
│                             │
│  Welcome back, John!        │
│                             │
│  ┌───────┐ ┌───────┐       │
│  │ 📝 12 │ │ 👁️1.2k│       │
│  │ Forms │ │ Views │       │
│  └───────┘ └───────┘       │
│                             │
│  ┌───────────────────────┐ │
│  │     [+ New Form]      │ │
│  └───────────────────────┘ │
│                             │
│  Recent Forms               │
│  ───────────────────────── │
│                             │
│  ┌───────────────────────┐ │
│  │ 📋 Customer Feedback  │ │
│  │ 2h ago • 156 responses│ │
│  │ [Edit] [Preview] [···]│ │
│  └───────────────────────┘ │
│                             │
│  ┌───────────────────────┐ │
│  │ 📋 Job Application    │ │
│  │ 1d ago • 42 responses │ │
│  │ [Edit] [Preview] [···]│ │
│  └───────────────────────┘ │
│                             │
│  ┌───────────────────────┐ │
│  │ 📋 Event Registration │ │
│  │ 3d ago • DRAFT        │ │
│  │ [Edit] [Preview] [···]│ │
│  └───────────────────────┘ │
│                             │
├─────────────────────────────┤
│  📊    📋    ➕    ⚙️      │
│  Home  Forms Create Settings│
└─────────────────────────────┘
```

### 3. Form Builder - Main View (Desktop)

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│  ← Back   Customer Feedback Survey                    [Save Draft] [Preview ▼] [Publish]│
├──────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│  ┌─────────────────┐ ┌──────────────────────────────────┐ ┌────────────────────────────┐│
│  │  FIELD TYPES    │ │      FORM CANVAS                 │ │   FIELD SETTINGS          ││
│  │  ─────────────  │ │      ────────────                │ │   ──────────────          ││
│  │                 │ │                                   │ │                           ││
│  │  📝 Short Text  │ │  ┌─────────────────────────────┐ │ │  Label                    ││
│  │  📄 Long Text   │ │  │  Welcome Screen        ⋮ ✕ │ │ │  ┌─────────────────────┐  ││
│  │  ✉️ Email       │ │  │                             │ │ │  │ Your Name           │  ││
│  │  📞 Phone       │ │  │  Welcome to our survey!     │ │ │  └─────────────────────┘  ││
│  │  🔢 Number      │ │  │  [Start]                    │ │ │                           ││
│  │  🔗 URL         │ │  └─────────────────────────────┘ │ │  Description (optional)   ││
│  │                 │ │                                   │ │  ┌─────────────────────┐  ││
│  │  📅 Date        │ │  ┌─────────────────────────────┐ │ │  │                     │  ││
│  │  🕐 Time        │ │  │  1. Your Name          ⋮ ✕ │ │ │  └─────────────────────┘  ││
│  │  📆 DateTime    │ │  │  ────────────────────────   │ │ │                           ││
│  │                 │ │  │  [Short text input     ]   │ │ │  Placeholder              ││
│  │  ▼ Dropdown     │ │  │                             │ │ │  ┌─────────────────────┐  ││
│  │  ◉ Choice       │ │  │  Required ✓                 │ │ │  │ Enter your name...  │  ││
│  │  ☑ Checkboxes   │ │  └─────────────────────────────┘ │ │  └─────────────────────┘  ││
│  │                 │ │         ↕ drag to reorder        │ │                           ││
│  │  ⭐ Rating      │ │  ┌─────────────────────────────┐ │ │  ┌───────────────────┐    ││
│  │  📊 Scale       │ │  │  2. Email Address      ⋮ ✕ │ │ │  │ ☑ Required        │    ││
│  │                 │ │  │  ────────────────────────   │ │ │  └───────────────────┘    ││
│  │  📎 File Upload │ │  │  [email@example.com    ]   │ │ │                           ││
│  │  ✍️ Signature   │ │  │                             │ │ │  VALIDATION               ││
│  │  💳 Payment     │ │  │  Required ✓                 │ │ │  ─────────                ││
│  │                 │ │  └─────────────────────────────┘ │ │  Min length: [    ]       ││
│  │  ─────────────  │ │                                   │ │  Max length: [    ]       ││
│  │  📢 Statement   │ │  ┌─────────────────────────────┐ │ │  Pattern:    [    ]       ││
│  │  🎉 Welcome     │ │  │  3. Rate Experience    ⋮ ✕ │ │ │                           ││
│  │  🙏 Thank You   │ │  │  ────────────────────────   │ │ │  CONDITIONAL LOGIC        ││
│  │  🔢 Calculated  │ │  │  ⭐ ⭐ ⭐ ⭐ ⭐              │ │ │  ─────────────────        ││
│  │                 │ │  │                             │ │ │  [+ Add Condition]        ││
│  │                 │ │  └─────────────────────────────┘ │ │                           ││
│  │                 │ │                                   │ │  Show this field when:    ││
│  │                 │ │  ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐ │ │  ┌─────────────────────┐  ││
│  │                 │ │  │                             │ │ │  │ email !== ""        │  ││
│  │                 │ │  │     + Add Field             │ │ │  └─────────────────────┘  ││
│  │                 │ │  │     (or drag here)          │ │ │                           ││
│  │                 │ │  └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘ │ │  [Test Expression]        ││
│  │                 │ │                                   │ │                           ││
│  └─────────────────┘ └──────────────────────────────────┘ └────────────────────────────┘│
│                                                                                          │
│  Form Settings | Theme | Logic Rules | Integrations                                     │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

### 4. Form Builder (Mobile)

```
┌─────────────────────────────┐
│  ←  Survey Name      [Save] │
├─────────────────────────────┤
│                             │
│  [Fields] [Canvas] [Settings]
│  ─────────────────────────  │
│                             │
│  ┌───────────────────────┐ │
│  │ 1. Your Name     ⋮ ✕  │ │
│  │ ───────────────────── │ │
│  │ [Short text input  ]  │ │
│  │ Required ✓            │ │
│  └───────────────────────┘ │
│         ↕ drag             │
│  ┌───────────────────────┐ │
│  │ 2. Email         ⋮ ✕  │ │
│  │ ───────────────────── │ │
│  │ [email@example.com ]  │ │
│  │ Required ✓            │ │
│  └───────────────────────┘ │
│         ↕ drag             │
│  ┌───────────────────────┐ │
│  │ 3. Rating        ⋮ ✕  │ │
│  │ ───────────────────── │ │
│  │ ⭐ ⭐ ⭐ ⭐ ⭐         │ │
│  └───────────────────────┘ │
│                             │
│  ┌───────────────────────┐ │
│  │     [+ Add Field]     │ │
│  └───────────────────────┘ │
│                             │
├─────────────────────────────┤
│  📝    🎨    ⚡    👁️      │
│ Fields Theme Logic Preview  │
└─────────────────────────────┘
```

### 5. Field Type Picker (Modal)

```
┌─────────────────────────────────────────────────────────────┐
│                     Add Field                          ✕    │
├─────────────────────────────────────────────────────────────┤
│  🔍 Search fields...                                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  TEXT INPUTS                                                │
│  ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐  │
│  │  📝       │ │  📄       │ │  ✉️       │ │  📞       │  │
│  │  Short    │ │  Long     │ │  Email    │ │  Phone    │  │
│  │  Text     │ │  Text     │ │           │ │           │  │
│  └───────────┘ └───────────┘ └───────────┘ └───────────┘  │
│                                                             │
│  ┌───────────┐ ┌───────────┐                               │
│  │  🔢       │ │  🔗       │                               │
│  │  Number   │ │  URL      │                               │
│  └───────────┘ └───────────┘                               │
│                                                             │
│  DATE & TIME                                                │
│  ┌───────────┐ ┌───────────┐ ┌───────────┐                 │
│  │  📅       │ │  🕐       │ │  📆       │                 │
│  │  Date     │ │  Time     │ │  DateTime │                 │
│  └───────────┘ └───────────┘ └───────────┘                 │
│                                                             │
│  CHOICES                                                    │
│  ┌───────────┐ ┌───────────┐ ┌───────────┐                 │
│  │  ▼        │ │  ◉        │ │  ☑        │                 │
│  │  Dropdown │ │  Multiple │ │  Checkbox │                 │
│  │           │ │  Choice   │ │           │                 │
│  └───────────┘ └───────────┘ └───────────┘                 │
│                                                             │
│  RATING & SCALE                                             │
│  ┌───────────┐ ┌───────────┐                               │
│  │  ⭐       │ │  📊       │                               │
│  │  Rating   │ │  Scale    │                               │
│  └───────────┘ └───────────┘                               │
│                                                             │
│  ADVANCED                                                   │
│  ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐  │
│  │  📎       │ │  ✍️       │ │  💳       │ │  🔢       │  │
│  │  File     │ │  Signature│ │  Payment  │ │ Calculated│  │
│  │  Upload   │ │           │ │  (Mock)   │ │           │  │
│  └───────────┘ └───────────┘ └───────────┘ └───────────┘  │
│                                                             │
│  LAYOUT                                                     │
│  ┌───────────┐ ┌───────────┐ ┌───────────┐                 │
│  │  📢       │ │  🎉       │ │  🙏       │                 │
│  │  Statement│ │  Welcome  │ │  Thank You│                 │
│  └───────────┘ └───────────┘ └───────────┘                 │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 6. Logic Editor Modal

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Conditional Logic Editor                           ✕    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Field: "Rate Experience"                                                   │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │ SIMPLE MODE                              [Switch to Expression Mode]  │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│  Show this field when:                                                      │
│                                                                             │
│  ┌─────────────────────┐ ┌──────────────┐ ┌─────────────────────────────┐  │
│  │ email             ▼ │ │ is not empty │ │                             │  │
│  └─────────────────────┘ └──────────────┘ └─────────────────────────────┘  │
│                                                                             │
│  [+ Add another condition]                                                  │
│                                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  Or use Expression Mode for advanced logic:                                 │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │  // FormLogic expression                                              │ │
│  │  email !== "" && (age >= 18 || hasParentConsent === true)            │ │
│  │                                                                       │ │
│  │                                                                       │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│  Available Fields:                                                          │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ • name (string)  • email (string)  • age (number)  • rating (number) │  │
│  │ • hasParentConsent (boolean)                                         │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │  Test Result: ✅ Expression is valid                                  │ │
│  │               Returns: true (field will be shown)                     │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│                                               [Cancel]  [Save Condition]    │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 7. Form Preview - Typeform Mode (Desktop)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  [Exit Preview]                    📱 Mobile  💻 Desktop  [Open in New Tab] │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│                                                                              │
│                                                                              │
│                                                                              │
│                                                                              │
│                       1 → What's your name?                                 │
│                                                                              │
│                       ┌────────────────────────────────────────┐            │
│                       │                                        │            │
│                       │  Type your answer here...              │            │
│                       │                                        │            │
│                       └────────────────────────────────────────┘            │
│                                                                              │
│                                         Press Enter ↵ or [OK ✓]             │
│                                                                              │
│                                                                              │
│                                                                              │
│                                                                              │
│                                                                              │
│                                                                              │
│                                                                              │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│  ▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  1 of 5          │
│                                                    [↑ Previous] [Next ↓]    │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 8. Form Preview - Typeform Mode (Mobile)

```
┌─────────────────────────────┐
│                             │
│  ▓▓▓▓░░░░░░░░░░░░░  1 of 5 │
│                             │
│                             │
│                             │
│                             │
│                             │
│   1 → What's your name?     │
│                             │
│   ┌───────────────────────┐ │
│   │                       │ │
│   │ Type your answer...   │ │
│   │                       │ │
│   └───────────────────────┘ │
│                             │
│                             │
│                             │
│                             │
│                             │
│                             │
│                             │
│   ┌───────────────────────┐ │
│   │        [OK ✓]         │ │
│   └───────────────────────┘ │
│                             │
│      ↑ Previous  Next ↓     │
│                             │
└─────────────────────────────┘
```

### 9. Form Preview - Classic/Scrollable Mode

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  [Exit Preview]                    📱 Mobile  💻 Desktop  [Open in New Tab] │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                                                                        │ │
│  │                    Customer Feedback Survey                            │ │
│  │                                                                        │ │
│  │    Help us improve our service by answering a few questions.          │ │
│  │                                                                        │ │
│  │    ────────────────────────────────────────────────────────────────   │ │
│  │                                                                        │ │
│  │    1. What's your name? *                                             │ │
│  │    ┌────────────────────────────────────────────────────────────┐     │ │
│  │    │                                                            │     │ │
│  │    └────────────────────────────────────────────────────────────┘     │ │
│  │                                                                        │ │
│  │    2. Email address *                                                 │ │
│  │    ┌────────────────────────────────────────────────────────────┐     │ │
│  │    │                                                            │     │ │
│  │    └────────────────────────────────────────────────────────────┘     │ │
│  │                                                                        │ │
│  │    3. How would you rate your experience? *                           │ │
│  │    ○ ⭐ Terrible                                                       │ │
│  │    ○ ⭐⭐ Poor                                                         │ │
│  │    ○ ⭐⭐⭐ Average                                                    │ │
│  │    ○ ⭐⭐⭐⭐ Good                                                     │ │
│  │    ○ ⭐⭐⭐⭐⭐ Excellent                                              │ │
│  │                                                                        │ │
│  │    4. Any additional comments?                                        │ │
│  │    ┌────────────────────────────────────────────────────────────┐     │ │
│  │    │                                                            │     │ │
│  │    │                                                            │     │ │
│  │    │                                                            │     │ │
│  │    └────────────────────────────────────────────────────────────┘     │ │
│  │                                                                        │ │
│  │                        ┌──────────────────────┐                       │ │
│  │                        │      Submit          │                       │ │
│  │                        └──────────────────────┘                       │ │
│  │                                                                        │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 10. Theme Editor Panel

```
┌─────────────────────────────────────────────────────────────┐
│                     Theme Customization                ✕    │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  PRESETS                                                    │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐          │
│  │ ████████│ │ ████████│ │ ████████│ │ ████████│          │
│  │ Default │ │ Dark    │ │ Ocean   │ │ Sunset  │          │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘          │
│                                                             │
│  COLORS                                                     │
│  ─────────────────────────────────────────────────────────  │
│                                                             │
│  Primary Color                                              │
│  ┌────────────────────────────────────────────┐ ┌───────┐  │
│  │ #6366F1                                    │ │ 🎨    │  │
│  └────────────────────────────────────────────┘ └───────┘  │
│                                                             │
│  Background Color                                           │
│  ┌────────────────────────────────────────────┐ ┌───────┐  │
│  │ #FFFFFF                                    │ │ 🎨    │  │
│  └────────────────────────────────────────────┘ └───────┘  │
│                                                             │
│  Text Color                                                 │
│  ┌────────────────────────────────────────────┐ ┌───────┐  │
│  │ #1F2937                                    │ │ 🎨    │  │
│  └────────────────────────────────────────────┘ └───────┘  │
│                                                             │
│  TYPOGRAPHY                                                 │
│  ─────────────────────────────────────────────────────────  │
│                                                             │
│  Font Family                                                │
│  ┌────────────────────────────────────────────────────┐    │
│  │ Inter                                           ▼  │    │
│  └────────────────────────────────────────────────────┘    │
│                                                             │
│  APPEARANCE                                                 │
│  ─────────────────────────────────────────────────────────  │
│                                                             │
│  Border Radius                                              │
│  ○ None   ○ Small   ● Medium   ○ Large                     │
│                                                             │
│  Background Image                                           │
│  ┌─────────────────────────────────────────┐               │
│  │  [+ Upload Image]  or  [Enter URL]      │               │
│  └─────────────────────────────────────────┘               │
│                                                             │
│  Logo                                                       │
│  ┌─────────────────────────────────────────┐               │
│  │  [+ Upload Logo]                        │               │
│  └─────────────────────────────────────────┘               │
│                                                             │
│                                    [Reset]  [Apply Theme]   │
└─────────────────────────────────────────────────────────────┘
```

### 11. Analytics View

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  ← Back   Customer Feedback Survey - Analytics              [Export CSV]    │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌────────────────┐ ┌────────────────┐ ┌────────────────┐ ┌────────────────┐│
│  │   156          │ │   89%          │ │   2m 34s       │ │   4.2 ⭐       ││
│  │   Responses    │ │   Completion   │ │   Avg. Time    │ │   Avg Rating   ││
│  │   +12 today    │ │   Rate         │ │                │ │                ││
│  └────────────────┘ └────────────────┘ └────────────────┘ └────────────────┘│
│                                                                              │
│  RESPONSES OVER TIME                                                         │
│  ─────────────────────────────────────────────────────────────────────────── │
│       ▲                                                                      │
│    40 │                              ████                                   │
│       │                         ████ ████ ████                              │
│    30 │                    ████ ████ ████ ████                              │
│       │               ████ ████ ████ ████ ████ ████                         │
│    20 │          ████ ████ ████ ████ ████ ████ ████                         │
│       │     ████ ████ ████ ████ ████ ████ ████ ████ ████                    │
│    10 │████ ████ ████ ████ ████ ████ ████ ████ ████ ████                    │
│       │████ ████ ████ ████ ████ ████ ████ ████ ████ ████                    │
│     0 └───────────────────────────────────────────────────────────────────► │
│         Mon  Tue  Wed  Thu  Fri  Sat  Sun  Mon  Tue  Wed                    │
│                                                                              │
│  FIELD BREAKDOWN                                                             │
│  ─────────────────────────────────────────────────────────────────────────── │
│                                                                              │
│  Q3: How would you rate your experience?                                    │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ ⭐⭐⭐⭐⭐ Excellent   ████████████████████████████████████████  45%     ││
│  │ ⭐⭐⭐⭐   Good        ██████████████████████████████  32%              ││
│  │ ⭐⭐⭐     Average     ████████████████  15%                            ││
│  │ ⭐⭐       Poor        ████  5%                                          ││
│  │ ⭐         Terrible    ██  3%                                           ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
│  RECENT RESPONSES                                             [View All]    │
│  ─────────────────────────────────────────────────────────────────────────── │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │ #156  John D.  |  john@email.com  |  ⭐⭐⭐⭐⭐  |  2 min ago          ││
│  │ #155  Sarah M. |  sarah@email.com |  ⭐⭐⭐⭐    |  15 min ago         ││
│  │ #154  Mike R.  |  mike@email.com  |  ⭐⭐⭐⭐⭐  |  1 hour ago         ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 12. Share Modal

```
┌─────────────────────────────────────────────────────────────┐
│                     Share Form                         ✕    │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  SHARE LINK                                                 │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ https://forms.example.com/s/abc123xyz               │   │
│  └─────────────────────────────────────────────────────┘   │
│                           [Copy Link]                       │
│                                                             │
│  ─────────────────────────────────────────────────────────  │
│                                                             │
│  EMBED CODE                                                 │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ <iframe src="https://forms.example.com/embed/...    │   │
│  │   width="100%" height="500" frameborder="0">        │   │
│  │ </iframe>                                           │   │
│  └─────────────────────────────────────────────────────┘   │
│                           [Copy Code]                       │
│                                                             │
│  ─────────────────────────────────────────────────────────  │
│                                                             │
│  EXPORT                                                     │
│                                                             │
│  ┌───────────────────┐  ┌───────────────────┐              │
│  │   📄 JSON Schema  │  │   📊 CSV Data     │              │
│  │   Download        │  │   Download        │              │
│  └───────────────────┘  └───────────────────┘              │
│                                                             │
│  QR CODE                                                    │
│  ┌─────────────────┐                                       │
│  │ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓ │                                       │
│  │ ▓▓          ▓▓ │    Scan to open form                   │
│  │ ▓▓  ▓▓▓▓▓▓  ▓▓ │                                       │
│  │ ▓▓  ▓▓▓▓▓▓  ▓▓ │    [Download QR]                      │
│  │ ▓▓          ▓▓ │                                       │
│  │ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓ │                                       │
│  └─────────────────┘                                       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Component Structure

```
src/
├── main.tsx                    # Entry point
├── App.tsx                     # Root component with routing
├── vite-env.d.ts
│
├── assets/                     # Static assets
│   └── logo.svg
│
├── components/
│   ├── ui/                     # Base UI components
│   │   ├── Button.tsx
│   │   ├── Input.tsx
│   │   ├── Modal.tsx
│   │   ├── Dropdown.tsx
│   │   ├── Tabs.tsx
│   │   ├── Card.tsx
│   │   ├── Badge.tsx
│   │   ├── Tooltip.tsx
│   │   ├── ColorPicker.tsx
│   │   └── ProgressBar.tsx
│   │
│   ├── layout/                 # Layout components
│   │   ├── AppShell.tsx
│   │   ├── Sidebar.tsx
│   │   ├── Header.tsx
│   │   ├── MobileNav.tsx
│   │   └── Container.tsx
│   │
│   ├── builder/                # Form builder components
│   │   ├── Builder.tsx         # Main builder container
│   │   ├── FieldPalette.tsx    # Field type picker sidebar
│   │   ├── Canvas.tsx          # Drag-drop form canvas
│   │   ├── FieldCard.tsx       # Field card in canvas
│   │   ├── FieldSettings.tsx   # Right panel settings
│   │   ├── LogicEditor.tsx     # Conditional logic editor
│   │   ├── ValidationEditor.tsx
│   │   ├── ThemeEditor.tsx     # Theme customization panel
│   │   ├── FormSettings.tsx    # Form-level settings
│   │   └── FieldTypeModal.tsx  # Field picker modal
│   │
│   ├── fields/                 # Individual field components
│   │   ├── BaseField.tsx       # Base field wrapper
│   │   ├── ShortTextField.tsx
│   │   ├── LongTextField.tsx
│   │   ├── EmailField.tsx
│   │   ├── PhoneField.tsx
│   │   ├── NumberField.tsx
│   │   ├── UrlField.tsx
│   │   ├── DateField.tsx
│   │   ├── TimeField.tsx
│   │   ├── DateTimeField.tsx
│   │   ├── DropdownField.tsx
│   │   ├── MultipleChoiceField.tsx
│   │   ├── CheckboxField.tsx
│   │   ├── RatingField.tsx
│   │   ├── ScaleField.tsx
│   │   ├── FileUploadField.tsx
│   │   ├── SignatureField.tsx
│   │   ├── PaymentField.tsx
│   │   ├── StatementField.tsx
│   │   ├── WelcomeScreen.tsx
│   │   ├── ThankYouScreen.tsx
│   │   ├── CalculatedField.tsx
│   │   └── index.ts            # Field registry
│   │
│   ├── preview/                # Form preview components
│   │   ├── PreviewContainer.tsx
│   │   ├── TypeformPreview.tsx # One-question-at-a-time
│   │   ├── ClassicPreview.tsx  # Scrollable form
│   │   ├── DeviceFrame.tsx     # Mobile/desktop frame
│   │   └── PreviewToolbar.tsx
│   │
│   ├── response/               # Form response/fill components
│   │   ├── FormResponse.tsx    # Public form view
│   │   ├── TypeformResponse.tsx
│   │   ├── ClassicResponse.tsx
│   │   └── SubmitSuccess.tsx
│   │
│   ├── analytics/              # Analytics components
│   │   ├── AnalyticsDashboard.tsx
│   │   ├── ResponsesChart.tsx
│   │   ├── FieldBreakdown.tsx
│   │   ├── ResponsesTable.tsx
│   │   └── StatCard.tsx
│   │
│   └── share/                  # Share components
│       ├── ShareModal.tsx
│       ├── EmbedCode.tsx
│       └── QRCode.tsx
│
├── pages/                      # Page components
│   ├── Dashboard.tsx
│   ├── FormsList.tsx
│   ├── FormBuilder.tsx
│   ├── FormPreview.tsx
│   ├── FormResponse.tsx
│   ├── FormAnalytics.tsx
│   └── Settings.tsx
│
├── stores/                     # Zustand stores
│   ├── formStore.ts            # Forms and fields state
│   ├── uiStore.ts              # UI state (modals, sidebar)
│   ├── responseStore.ts        # Form responses
│   └── themeStore.ts           # Theme settings
│
├── hooks/                      # Custom hooks
│   ├── useFormLogic.ts         # FormLogic engine hook
│   ├── useFieldValidation.ts
│   ├── useConditionalLogic.ts
│   ├── useDragDrop.ts
│   ├── useLocalStorage.ts
│   ├── useFormResponses.ts
│   └── useTheme.ts
│
├── lib/                        # Utilities and helpers
│   ├── formlogic/              # FormLogic integration
│   │   ├── engine.ts           # Engine wrapper
│   │   ├── modules.ts          # Custom modules for forms
│   │   └── validators.ts       # Built-in validators
│   │
│   ├── storage.ts              # LocalStorage/IndexedDB utils
│   ├── export.ts               # JSON/CSV export
│   ├── fieldDefaults.ts        # Default field configs
│   └── utils.ts                # General utilities
│
├── types/                      # TypeScript types
│   ├── form.ts                 # Form/Field types
│   ├── theme.ts                # Theme types
│   └── response.ts             # Response types
│
└── styles/
    └── globals.css             # Global Tailwind styles
```

---

## Feature Breakdown

### Phase 1: Foundation
- Project setup (Vite + React + TypeScript + Tailwind)
- Base UI components
- Layout components (AppShell, Sidebar, Header)
- Routing setup
- Zustand stores setup
- Dashboard page (mock data)
- Forms list page

### Phase 2: Form Builder Core
- Form canvas with drag-and-drop (@dnd-kit)
- Field palette/picker
- Basic field components (text, email, number)
- Field settings panel
- Field reordering
- Save/load forms to LocalStorage

### Phase 3: All Field Types
- All text input fields
- Date/time fields
- Choice fields (dropdown, radio, checkbox)
- Rating and scale fields
- File upload field (with IndexedDB)
- Signature field (canvas-based)
- Payment field (mock)
- Welcome/Thank you screens
- Statement/content blocks

### Phase 4: FormLogic Integration
- FormLogic engine wrapper
- Conditional logic editor (simple mode)
- Conditional logic editor (expression mode)
- Custom validation expressions
- Calculated fields
- Field visibility rules
- Skip logic

### Phase 5: Preview & Response
- Live preview panel
- Full-screen preview mode
- Typeform mode (one-at-a-time)
- Classic mode (scrollable)
- Device frame (mobile/desktop)
- Public form response view
- Form submission handling
- Thank you page

### Phase 6: Theme & Customization
- Theme editor panel
- Color customization
- Font selection
- Border radius options
- Background image upload
- Logo upload
- Theme presets

### Phase 7: Analytics & Export
- Analytics dashboard (mock data)
- Response charts
- Field breakdown stats
- Responses table
- CSV export
- JSON schema export
- Share modal with QR code

### Phase 8: Polish & Mobile
- Mobile-responsive builder
- Mobile navigation
- Touch-friendly drag-drop
- Keyboard shortcuts
- Undo/redo functionality
- Form duplication
- Form templates

---

## FormLogic Integration

### Engine Wrapper

```typescript
// lib/formlogic/engine.ts
import { FormLogicEngine } from 'formlogic-lang';

class FormLogicService {
  private engine: FormLogicEngine;

  constructor() {
    this.engine = new FormLogicEngine();
    this.registerFormModules();
  }

  private registerFormModules() {
    // Register validators module
    this.engine.registerModule('validators', {
      email: (args) => { /* email validation */ },
      phone: (args) => { /* phone validation */ },
      url: (args) => { /* url validation */ },
      minLength: (args) => { /* min length check */ },
      maxLength: (args) => { /* max length check */ },
      pattern: (args) => { /* regex pattern match */ },
    });

    // Register formatters module
    this.engine.registerModule('format', {
      currency: (args) => { /* format as currency */ },
      date: (args) => { /* format date */ },
      phone: (args) => { /* format phone */ },
    });
  }

  // Evaluate conditional visibility
  async evaluateCondition(
    expression: string,
    formData: Record<string, any>
  ): Promise<boolean> {
    return await this.engine.eval(expression, formData);
  }

  // Validate field with expression
  async validateField(
    expression: string,
    value: any,
    formData: Record<string, any>
  ): Promise<string | null> {
    return await this.engine.eval(expression, { value, ...formData });
  }

  // Calculate field value
  async calculateValue(
    expression: string,
    formData: Record<string, any>
  ): Promise<any> {
    return await this.engine.eval(expression, formData);
  }
}

export const formLogicService = new FormLogicService();
```

### Conditional Logic Examples

```javascript
// Simple visibility condition
email !== "" && email !== null

// Complex condition with multiple fields
age >= 18 && (country === "US" || country === "CA")

// Condition with array check
selectedProducts.includes("premium")

// Condition with calculation
subtotal + shipping > 100

// Custom validation expression
(() => {
  if (value.length < 8) return "Password must be at least 8 characters";
  if (!value.match(/[A-Z]/)) return "Must contain uppercase letter";
  if (!value.match(/[0-9]/)) return "Must contain a number";
  return null; // Valid
})()

// Calculated field expression
(() => {
  let subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  let tax = subtotal * 0.08;
  let shipping = subtotal > 100 ? 0 : 9.99;
  return subtotal + tax + shipping;
})()
```

---

## Implementation Phases

### Phase 1: Foundation (Core Setup)
1. Initialize Vite project with React + TypeScript
2. Configure Tailwind CSS
3. Create base UI component library
4. Set up React Router with all routes
5. Create layout components (AppShell, Sidebar, Header)
6. Set up Zustand stores
7. Build Dashboard page with mock data
8. Build Forms list page

### Phase 2: Form Builder Core
1. Create field type definitions and registry
2. Build FieldPalette component
3. Implement drag-and-drop with @dnd-kit
4. Create Canvas component
5. Build FieldCard component
6. Create FieldSettings panel
7. Implement basic fields (ShortText, LongText, Email, Number)
8. Add LocalStorage persistence

### Phase 3: Complete Field Library
1. Implement all text input fields
2. Build date/time picker fields
3. Create choice fields (dropdown, radio, checkbox)
4. Implement rating and scale components
5. Build file upload with IndexedDB storage
6. Create signature pad component
7. Add payment field (mock)
8. Build screen components (Welcome, ThankYou, Statement)

### Phase 4: FormLogic Integration
1. Create FormLogic engine wrapper
2. Register custom form modules
3. Build simple condition builder UI
4. Create expression editor with syntax highlighting
5. Implement conditional field visibility
6. Add custom validation expressions
7. Build calculated field component
8. Add skip logic support

### Phase 5: Preview & Response
1. Build preview container with device frames
2. Implement Typeform-style preview
3. Implement Classic scrollable preview
4. Create public form response view
5. Build form navigation (next/prev)
6. Add progress indicator
7. Implement submission handling
8. Create success/thank you view

### Phase 6: Theme & Customization
1. Build theme editor panel
2. Implement color picker integration
3. Add font family selector
4. Create border radius options
5. Add background image upload
6. Implement logo upload
7. Create theme presets
8. Apply theme to preview/response

### Phase 7: Analytics & Export
1. Build analytics dashboard layout
2. Create stat cards
3. Implement response chart (mock data)
4. Build field breakdown visualization
5. Create responses data table
6. Implement CSV export
7. Add JSON schema export
8. Build share modal with QR code

### Phase 8: Polish & Mobile
1. Optimize for mobile responsive
2. Create mobile navigation
3. Improve touch interactions
4. Add keyboard shortcuts
5. Implement undo/redo
6. Add form duplication
7. Create starter templates
8. Performance optimization

---

## File Structure Summary

```
formlogic.com/
├── formlogic-typescript/       # Logic engine (existing)
│   └── src/
│       ├── engine.ts
│       ├── vm.ts
│       ├── compiler.ts
│       └── ...
│
└── form-builder/               # New React app
    ├── package.json
    ├── vite.config.ts
    ├── tailwind.config.js
    ├── tsconfig.json
    ├── index.html
    └── src/
        ├── main.tsx
        ├── App.tsx
        ├── components/
        ├── pages/
        ├── stores/
        ├── hooks/
        ├── lib/
        ├── types/
        └── styles/
```

---

## Success Criteria

1. **Mobile-Friendly**: Fully responsive on all device sizes
2. **Intuitive Builder**: Drag-and-drop interface that feels natural
3. **Powerful Logic**: FormLogic enables complex conditions/validations
4. **Beautiful Forms**: Professional-looking forms with theme customization
5. **Two Modes**: Both Typeform-style and classic forms work seamlessly
6. **Performant**: Smooth animations and fast interactions
7. **Export Ready**: JSON schemas can be used with any backend
8. **Accessible**: WCAG 2.1 AA compliance for forms

---

## Notes

- All data stored in browser (LocalStorage + IndexedDB)
- FormLogic engine provides sandboxed, safe expression evaluation
- Design system uses Tailwind with custom component library
- Mobile-first approach with progressive enhancement
- Focus on UX with smooth animations via Framer Motion
