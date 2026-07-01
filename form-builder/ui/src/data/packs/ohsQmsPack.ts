// ── Type re-use ─────────────────────────────────────────────────────────────
import type { PackData } from './financeOsPack';

// ── Shared defaults ─────────────────────────────────────────────────────────

const defaultSettings: Record<string, unknown> = {
  presentationMode: 'both',
  defaultPresentationMode: 'focused',
  showProgressBar: true,
  allowBackNavigation: true,
  submitButtonText: 'Submit',
  notifications: { emailNotifications: false },
  isClosed: false,
};

const complianceSettings: Record<string, unknown> = {
  ...defaultSettings,
  showNigoDashboard: true,
};

const defaultTheme: Record<string, unknown> = {
  primaryColor: '#dc2626',
  backgroundColor: '#ffffff',
  textColor: '#1f2937',
  fontFamily: 'Inter',
  borderRadius: 'medium',
};

// ── Pack data ───────────────────────────────────────────────────────────────

export const ohsQmsPack: PackData = {
  formatVersion: 1,
  packMeta: {
    id: 'ohs-qms',
    name: 'OHS & Quality Management',
    description:
      'Comprehensive Occupational Health & Safety and Quality Management pack covering incident reporting, hazard identification, risk assessment, audits, corrective actions, non-conformances, training, and contractor management. Aligned with ISO 45001 and ISO 9001.',
    version: '1.0.0',
    author: 'FormLogic',
    tags: ['ohs', 'whs', 'safety', 'quality', 'iso-45001', 'iso-9001', 'compliance', 'risk-management'],
  },

  // ────────────────────────────────────────────────────────────────────────
  // FORMS
  // ────────────────────────────────────────────────────────────────────────
  forms: [
    // ── 1. Incident Report ──────────────────────────────────────────────
    {
      packFormId: 'incident-report',
      title: 'Incident Report',
      icon: 'AlertTriangle',
      description:
        'Report workplace incidents including near-misses, injuries, property damage, environmental, and security events.',
      settings: { ...complianceSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'welcome',
          type: 'welcome_screen',
          label: 'Report a Workplace Incident',
          description:
            'Use this form to report any workplace incident. All reports are confidential and will be investigated promptly.',
          required: false,
          properties: {},
        },
        {
          id: 'incident_title',
          type: 'short_text',
          label: 'Incident Title',
          required: true,
          properties: { placeholder: 'Brief description of the incident' },
        },
        {
          id: 'incident_date',
          type: 'date',
          label: 'Date of Incident',
          required: true,
          properties: {},
        },
        {
          id: 'incident_time',
          type: 'time',
          label: 'Time of Incident',
          required: true,
          properties: {},
        },
        {
          id: 'location',
          type: 'short_text',
          label: 'Location',
          required: true,
          properties: { placeholder: 'Where did the incident occur?' },
        },
        {
          id: 'incident_type',
          type: 'dropdown',
          label: 'Incident Type',
          required: true,
          properties: {
            options: [
              { id: 'near_miss', label: 'Near Miss', value: 'near_miss' },
              { id: 'injury', label: 'Injury', value: 'injury' },
              { id: 'property_damage', label: 'Property Damage', value: 'property_damage' },
              { id: 'environmental', label: 'Environmental', value: 'environmental' },
              { id: 'security', label: 'Security', value: 'security' },
              { id: 'other_it', label: 'Other', value: 'other' },
            ],
          },
        },
        {
          id: 'severity',
          type: 'dropdown',
          label: 'Severity',
          required: true,
          properties: {
            options: [
              { id: 'low', label: 'Low', value: 'low' },
              { id: 'medium', label: 'Medium', value: 'medium' },
              { id: 'high', label: 'High', value: 'high' },
              { id: 'critical', label: 'Critical', value: 'critical' },
            ],
          },
        },
        {
          id: 'description',
          type: 'long_text',
          label: 'Description',
          description: 'Provide a detailed description of what happened.',
          required: true,
          properties: { placeholder: 'Describe the incident in detail...' },
        },
        {
          id: 'reported_by',
          type: 'short_text',
          label: 'Reported By',
          required: true,
          properties: { placeholder: 'Your full name' },
        },
        {
          id: 'witnesses',
          type: 'long_text',
          label: 'Witnesses',
          required: false,
          properties: { placeholder: 'Names of any witnesses (one per line)' },
        },
        {
          id: 'immediate_actions',
          type: 'long_text',
          label: 'Immediate Actions Taken',
          required: false,
          properties: { placeholder: 'What actions were taken immediately after the incident?' },
        },
        {
          id: 'root_cause',
          type: 'long_text',
          label: 'Root Cause (if known)',
          required: false,
          properties: { placeholder: 'What was the underlying cause?' },
        },
        {
          id: 'photos',
          type: 'file_upload',
          label: 'Photos / Evidence',
          required: false,
          properties: {
            acceptedFileTypes: ['.jpg', '.png', '.pdf'],
            allowMultiple: true,
          },
        },
        {
          id: 'thank_you',
          type: 'thank_you',
          label: 'Report Submitted',
          description: 'Thank you for reporting this incident. It will be reviewed and investigated promptly.',
          required: false,
          properties: {},
        },
      ],
    },

    // ── 2. Injury Record ────────────────────────────────────────────────
    {
      packFormId: 'injury-record',
      title: 'Injury Record',
      icon: 'HeartPulse',
      description:
        'Document workplace injuries, treatment, and return-to-work tracking.',
      settings: { ...complianceSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'incident_record',
          type: 'linked_record',
          label: 'Related Incident',
          description: 'Link to the incident report for this injury, if applicable.',
          required: false,
          properties: { targetFormId: '@pack:incident-report' },
        },
        {
          id: 'employee_name',
          type: 'short_text',
          label: 'Employee Name',
          required: true,
          properties: { placeholder: 'Full name of injured person' },
        },
        {
          id: 'injury_date',
          type: 'date',
          label: 'Date of Injury',
          required: true,
          properties: {},
        },
        {
          id: 'injury_type',
          type: 'dropdown',
          label: 'Injury Type',
          required: true,
          properties: {
            options: [
              { id: 'strain', label: 'Strain / Sprain', value: 'strain' },
              { id: 'laceration', label: 'Laceration / Cut', value: 'laceration' },
              { id: 'fracture', label: 'Fracture', value: 'fracture' },
              { id: 'burn', label: 'Burn', value: 'burn' },
              { id: 'contusion', label: 'Contusion / Bruise', value: 'contusion' },
              { id: 'eye_injury', label: 'Eye Injury', value: 'eye_injury' },
              { id: 'hearing', label: 'Hearing Damage', value: 'hearing' },
              { id: 'respiratory', label: 'Respiratory', value: 'respiratory' },
              { id: 'other_inj', label: 'Other', value: 'other' },
            ],
          },
        },
        {
          id: 'body_part',
          type: 'short_text',
          label: 'Body Part Affected',
          required: true,
          properties: { placeholder: 'e.g. Left hand, Lower back' },
        },
        {
          id: 'injury_description',
          type: 'long_text',
          label: 'Injury Description',
          required: true,
          properties: { placeholder: 'Describe the injury in detail' },
        },
        {
          id: 'treatment',
          type: 'long_text',
          label: 'Treatment Provided',
          required: true,
          properties: { placeholder: 'First aid, hospital visit, etc.' },
        },
        {
          id: 'lost_time',
          type: 'multiple_choice',
          label: 'Lost Time Injury?',
          required: true,
          properties: {
            options: [
              { id: 'yes', label: 'Yes', value: 'yes' },
              { id: 'no', label: 'No', value: 'no' },
            ],
          },
        },
        {
          id: 'lost_time_start',
          type: 'date',
          label: 'Lost Time Start Date',
          required: false,
          properties: {},
          conditionalLogic: { expression: 'lost_time == "yes"', action: 'show' },
        },
        {
          id: 'lost_time_end',
          type: 'date',
          label: 'Lost Time End Date',
          required: false,
          properties: {},
          conditionalLogic: { expression: 'lost_time == "yes"', action: 'show' },
        },
        {
          id: 'rtw_date',
          type: 'date',
          label: 'Expected Return to Work Date',
          required: false,
          properties: {},
          conditionalLogic: { expression: 'lost_time == "yes"', action: 'show' },
        },
        {
          id: 'treatment_notes',
          type: 'long_text',
          label: 'Ongoing Treatment Notes',
          required: false,
          properties: { placeholder: 'Any ongoing treatment or follow-up required' },
        },
      ],
    },

    // ── 3. Hazard Identification ────────────────────────────────────────
    {
      packFormId: 'hazard-identification',
      title: 'Hazard Identification',
      icon: 'AlertCircle',
      description:
        'Identify, assess, and record workplace hazards with risk matrix scoring.',
      settings: { ...complianceSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'hazard_title',
          type: 'short_text',
          label: 'Hazard Title',
          required: true,
          properties: { placeholder: 'Brief description of the hazard' },
        },
        {
          id: 'location',
          type: 'short_text',
          label: 'Location',
          required: true,
          properties: { placeholder: 'Where is the hazard located?' },
        },
        {
          id: 'hazard_type',
          type: 'dropdown',
          label: 'Hazard Type',
          required: true,
          properties: {
            options: [
              { id: 'physical', label: 'Physical', value: 'physical' },
              { id: 'chemical', label: 'Chemical', value: 'chemical' },
              { id: 'biological', label: 'Biological', value: 'biological' },
              { id: 'ergonomic', label: 'Ergonomic', value: 'ergonomic' },
              { id: 'psychosocial', label: 'Psychosocial', value: 'psychosocial' },
              { id: 'environmental', label: 'Environmental', value: 'environmental' },
              { id: 'other_ht', label: 'Other', value: 'other' },
            ],
          },
        },
        {
          id: 'hazard_description',
          type: 'long_text',
          label: 'Description',
          required: true,
          properties: { placeholder: 'Describe the hazard and potential harm' },
        },
        {
          id: 'reported_by',
          type: 'short_text',
          label: 'Reported By',
          required: true,
          properties: { placeholder: 'Your full name' },
        },
        {
          id: 'likelihood',
          type: 'scale',
          label: 'Likelihood',
          description: '1 = Rare, 2 = Unlikely, 3 = Possible, 4 = Likely, 5 = Almost Certain',
          required: true,
          properties: { min: 1, max: 5, step: 1 },
        },
        {
          id: 'consequence',
          type: 'scale',
          label: 'Consequence',
          description: '1 = Insignificant, 2 = Minor, 3 = Moderate, 4 = Major, 5 = Catastrophic',
          required: true,
          properties: { min: 1, max: 5, step: 1 },
        },
        {
          id: 'risk_score',
          type: 'calculated',
          label: 'Risk Score',
          description: 'Likelihood x Consequence (1-25)',
          required: false,
          properties: {
            calculationExpression: 'likelihood * consequence',
          },
        },
        {
          id: 'risk_level',
          type: 'calculated',
          label: 'Risk Level',
          description: 'Critical / High / Medium / Low based on risk score.',
          required: false,
          properties: {
            calculationExpression: 'risk_score >= 20 ? "Critical" : risk_score >= 12 ? "High" : risk_score >= 6 ? "Medium" : "Low"',
          },
        },
        {
          id: 'control_type',
          type: 'dropdown',
          label: 'Proposed Control Type',
          description: 'Select from the hierarchy of controls.',
          required: true,
          properties: {
            options: [
              { id: 'elimination', label: 'Elimination', value: 'elimination' },
              { id: 'substitution', label: 'Substitution', value: 'substitution' },
              { id: 'engineering', label: 'Engineering Controls', value: 'engineering' },
              { id: 'administrative', label: 'Administrative Controls', value: 'administrative' },
              { id: 'ppe', label: 'PPE', value: 'ppe' },
            ],
          },
        },
        {
          id: 'control_description',
          type: 'long_text',
          label: 'Control Measures',
          required: true,
          properties: { placeholder: 'Describe the proposed control measures' },
        },
        {
          id: 'residual_risk',
          type: 'calculated',
          label: 'Residual Risk Score',
          description: 'Estimated risk after controls are applied.',
          required: false,
          properties: {
            calculationExpression: 'control_type == "elimination" ? 0 : control_type == "substitution" ? Math.round(risk_score * 0.3) : control_type == "engineering" ? Math.round(risk_score * 0.4) : control_type == "administrative" ? Math.round(risk_score * 0.6) : Math.round(risk_score * 0.8)',
          },
        },
        {
          id: 'photos',
          type: 'file_upload',
          label: 'Photos',
          required: false,
          properties: {
            acceptedFileTypes: ['.jpg', '.png', '.pdf'],
            allowMultiple: true,
          },
        },
      ],
    },

    // ── 4. Action Item ──────────────────────────────────────────────────
    {
      packFormId: 'action-item',
      title: 'Action Item',
      icon: 'ClipboardCheck',
      description:
        'Create and track corrective or preventive actions arising from incidents, audits, or hazard reviews.',
      settings: { ...complianceSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'action_title',
          type: 'short_text',
          label: 'Action Title',
          required: true,
          properties: { placeholder: 'Brief description of the action required' },
        },
        {
          id: 'action_description',
          type: 'long_text',
          label: 'Description',
          required: true,
          properties: { placeholder: 'Detailed description of the action' },
        },
        {
          id: 'source_type',
          type: 'dropdown',
          label: 'Source',
          description: 'What triggered this action?',
          required: true,
          properties: {
            options: [
              { id: 'incident', label: 'Incident', value: 'incident' },
              { id: 'hazard', label: 'Hazard', value: 'hazard' },
              { id: 'audit', label: 'Audit', value: 'audit' },
              { id: 'car', label: 'Corrective Action Request', value: 'car' },
              { id: 'ncr', label: 'Non-Conformance', value: 'ncr' },
              { id: 'complaint', label: 'Complaint', value: 'complaint' },
              { id: 'other_src', label: 'Other', value: 'other' },
            ],
          },
        },
        {
          id: 'source_incident',
          type: 'linked_record',
          label: 'Source Incident',
          description: 'Link to the related incident report, if applicable.',
          required: false,
          properties: { targetFormId: '@pack:incident-report' },
        },
        {
          id: 'source_hazard',
          type: 'linked_record',
          label: 'Source Hazard',
          description: 'Link to the related hazard identification, if applicable.',
          required: false,
          properties: { targetFormId: '@pack:hazard-identification' },
        },
        {
          id: 'source_audit',
          type: 'linked_record',
          label: 'Source Audit',
          description: 'Link to the related audit report, if applicable.',
          required: false,
          properties: { targetFormId: '@pack:audit-report' },
        },
        {
          id: 'priority',
          type: 'dropdown',
          label: 'Priority',
          required: true,
          properties: {
            options: [
              { id: 'low', label: 'Low', value: 'low' },
              { id: 'medium', label: 'Medium', value: 'medium' },
              { id: 'high', label: 'High', value: 'high' },
              { id: 'critical', label: 'Critical', value: 'critical' },
            ],
          },
        },
        {
          id: 'assigned_to',
          type: 'short_text',
          label: 'Assigned To',
          required: true,
          properties: { placeholder: 'Person responsible' },
        },
        {
          id: 'due_date',
          type: 'date',
          label: 'Due Date',
          required: true,
          properties: {},
        },
        {
          id: 'notes',
          type: 'long_text',
          label: 'Notes',
          required: false,
          properties: { placeholder: 'Additional notes or context' },
        },
      ],
    },

    // ── 5. Audit Report ─────────────────────────────────────────────────
    {
      packFormId: 'audit-report',
      title: 'Audit Report',
      icon: 'ClipboardList',
      description:
        'Document internal, external, or ISO compliance audits with findings and observations.',
      settings: { ...complianceSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'audit_title',
          type: 'short_text',
          label: 'Audit Title',
          required: true,
          properties: { placeholder: 'e.g. Q1 Internal Safety Audit' },
        },
        {
          id: 'audit_type',
          type: 'dropdown',
          label: 'Audit Type',
          required: true,
          properties: {
            options: [
              { id: 'internal', label: 'Internal', value: 'internal' },
              { id: 'external', label: 'External', value: 'external' },
              { id: 'iso', label: 'ISO Certification', value: 'iso' },
              { id: 'regulatory', label: 'Regulatory', value: 'regulatory' },
              { id: 'supplier', label: 'Supplier', value: 'supplier' },
              { id: 'other_at', label: 'Other', value: 'other' },
            ],
          },
        },
        {
          id: 'audit_date',
          type: 'date',
          label: 'Audit Date',
          required: true,
          properties: {},
        },
        {
          id: 'auditor_name',
          type: 'short_text',
          label: 'Auditor Name',
          required: true,
          properties: { placeholder: 'Lead auditor name' },
        },
        {
          id: 'scope',
          type: 'long_text',
          label: 'Audit Scope',
          required: true,
          properties: { placeholder: 'Areas, processes, or standards being audited' },
        },
        {
          id: 'summary',
          type: 'long_text',
          label: 'Audit Summary',
          required: true,
          properties: { placeholder: 'Overall audit findings summary' },
        },
        {
          id: 'observations',
          type: 'long_text',
          label: 'Observations',
          required: false,
          properties: { placeholder: 'General observations during the audit' },
        },
        {
          id: 'findings',
          type: 'long_text',
          label: 'Findings',
          description: 'List all non-conformances and opportunities for improvement.',
          required: false,
          properties: { placeholder: 'Detail each finding (one per paragraph)' },
        },
        {
          id: 'finding_severity',
          type: 'dropdown',
          label: 'Highest Finding Severity',
          required: true,
          properties: {
            options: [
              { id: 'observation', label: 'Observation', value: 'observation' },
              { id: 'minor', label: 'Minor Non-Conformance', value: 'minor' },
              { id: 'major', label: 'Major Non-Conformance', value: 'major' },
              { id: 'critical', label: 'Critical Non-Conformance', value: 'critical' },
              { id: 'opportunity', label: 'Opportunity for Improvement', value: 'opportunity' },
            ],
          },
        },
        {
          id: 'corrective_actions_required',
          type: 'multiple_choice',
          label: 'Corrective Actions Required?',
          required: true,
          properties: {
            options: [
              { id: 'yes', label: 'Yes', value: 'yes' },
              { id: 'no', label: 'No', value: 'no' },
            ],
          },
        },
        {
          id: 'follow_up_date',
          type: 'date',
          label: 'Follow-up Audit Date',
          required: false,
          properties: {},
        },
        {
          id: 'audit_report_file',
          type: 'file_upload',
          label: 'Audit Report Document',
          required: false,
          properties: { acceptedFileTypes: ['.pdf', '.doc', '.docx'] },
        },
      ],
    },

    // ── 6. Corrective Action Request (CAR) ──────────────────────────────
    {
      packFormId: 'car',
      title: 'Corrective Action Request',
      icon: 'Wrench',
      description:
        'Raise and track corrective action requests for addressing root causes of non-conformances.',
      settings: { ...complianceSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'car_title',
          type: 'short_text',
          label: 'CAR Title',
          required: true,
          properties: { placeholder: 'Brief description of the issue' },
        },
        {
          id: 'car_description',
          type: 'long_text',
          label: 'Description',
          required: true,
          properties: { placeholder: 'Describe the non-conformance or issue in detail' },
        },
        {
          id: 'source_type',
          type: 'dropdown',
          label: 'Source',
          required: true,
          properties: {
            options: [
              { id: 'audit', label: 'Audit', value: 'audit' },
              { id: 'incident', label: 'Incident', value: 'incident' },
              { id: 'complaint', label: 'Complaint', value: 'complaint' },
              { id: 'ncr', label: 'Non-Conformance Report', value: 'ncr' },
              { id: 'other_src', label: 'Other', value: 'other' },
            ],
          },
        },
        {
          id: 'source_reference',
          type: 'short_text',
          label: 'Source Reference',
          required: false,
          properties: { placeholder: 'e.g. Audit #123, NCR #456' },
        },
        {
          id: 'source_audit',
          type: 'linked_record',
          label: 'Source Audit',
          description: 'Link to the related audit report, if applicable.',
          required: false,
          properties: { targetFormId: '@pack:audit-report' },
        },
        {
          id: 'source_incident',
          type: 'linked_record',
          label: 'Source Incident',
          description: 'Link to the related incident report, if applicable.',
          required: false,
          properties: { targetFormId: '@pack:incident-report' },
        },
        {
          id: 'raised_by',
          type: 'short_text',
          label: 'Raised By',
          required: true,
          properties: { placeholder: 'Person raising the CAR' },
        },
        {
          id: 'raised_date',
          type: 'date',
          label: 'Date Raised',
          required: true,
          properties: {},
        },
        {
          id: 'assigned_to',
          type: 'short_text',
          label: 'Assigned To',
          required: true,
          properties: { placeholder: 'Person responsible for resolution' },
        },
        {
          id: 'due_date',
          type: 'date',
          label: 'Due Date',
          required: true,
          properties: {},
        },
        {
          id: 'priority',
          type: 'dropdown',
          label: 'Priority',
          required: true,
          properties: {
            options: [
              { id: 'low', label: 'Low', value: 'low' },
              { id: 'medium', label: 'Medium', value: 'medium' },
              { id: 'high', label: 'High', value: 'high' },
              { id: 'critical', label: 'Critical', value: 'critical' },
            ],
          },
        },
        {
          id: 'root_cause',
          type: 'long_text',
          label: 'Root Cause Analysis',
          required: false,
          properties: { placeholder: 'Identify the root cause (use 5-Why, fishbone, etc.)' },
        },
        {
          id: 'corrective_action',
          type: 'long_text',
          label: 'Corrective Action',
          required: false,
          properties: { placeholder: 'Describe the corrective action to be taken' },
        },
        {
          id: 'preventive_action',
          type: 'long_text',
          label: 'Preventive Action',
          required: false,
          properties: { placeholder: 'Describe actions to prevent recurrence' },
        },
      ],
    },

    // ── 7. Non-Conformance Report (NCR) ─────────────────────────────────
    {
      packFormId: 'ncr',
      title: 'Non-Conformance Report',
      icon: 'FileWarning',
      description:
        'Document non-conformances related to products, processes, systems, or suppliers.',
      settings: { ...complianceSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'ncr_title',
          type: 'short_text',
          label: 'NCR Title',
          required: true,
          properties: { placeholder: 'Brief description of the non-conformance' },
        },
        {
          id: 'ncr_type',
          type: 'dropdown',
          label: 'NCR Type',
          required: true,
          properties: {
            options: [
              { id: 'product', label: 'Product', value: 'product' },
              { id: 'process', label: 'Process', value: 'process' },
              { id: 'system', label: 'System', value: 'system' },
              { id: 'supplier', label: 'Supplier', value: 'supplier' },
              { id: 'other_nt', label: 'Other', value: 'other' },
            ],
          },
        },
        {
          id: 'ncr_description',
          type: 'long_text',
          label: 'Description',
          required: true,
          properties: { placeholder: 'Detailed description of the non-conformance' },
        },
        {
          id: 'severity',
          type: 'dropdown',
          label: 'Severity',
          required: true,
          properties: {
            options: [
              { id: 'minor', label: 'Minor', value: 'minor' },
              { id: 'major', label: 'Major', value: 'major' },
              { id: 'critical', label: 'Critical', value: 'critical' },
            ],
          },
        },
        {
          id: 'source_type',
          type: 'dropdown',
          label: 'Source',
          required: true,
          properties: {
            options: [
              { id: 'audit', label: 'Audit', value: 'audit' },
              { id: 'inspection', label: 'Inspection', value: 'inspection' },
              { id: 'customer', label: 'Customer', value: 'customer' },
              { id: 'internal', label: 'Internal', value: 'internal' },
              { id: 'supplier', label: 'Supplier', value: 'supplier' },
              { id: 'other_src', label: 'Other', value: 'other' },
            ],
          },
        },
        {
          id: 'source_audit',
          type: 'linked_record',
          label: 'Source Audit',
          description: 'Link to the related audit report, if applicable.',
          required: false,
          properties: { targetFormId: '@pack:audit-report' },
        },
        {
          id: 'raised_by',
          type: 'short_text',
          label: 'Raised By',
          required: true,
          properties: { placeholder: 'Person who identified the NCR' },
        },
        {
          id: 'raised_date',
          type: 'date',
          label: 'Date Raised',
          required: true,
          properties: {},
        },
        {
          id: 'assigned_to',
          type: 'short_text',
          label: 'Assigned To',
          required: true,
          properties: { placeholder: 'Person responsible for resolution' },
        },
        {
          id: 'due_date',
          type: 'date',
          label: 'Due Date',
          required: true,
          properties: {},
        },
        {
          id: 'root_cause',
          type: 'long_text',
          label: 'Root Cause',
          required: false,
          properties: { placeholder: 'Identify the root cause' },
        },
        {
          id: 'disposition',
          type: 'dropdown',
          label: 'Disposition',
          required: false,
          properties: {
            options: [
              { id: 'rework', label: 'Rework', value: 'rework' },
              { id: 'scrap', label: 'Scrap', value: 'scrap' },
              { id: 'accept_as_is', label: 'Accept as Is', value: 'accept_as_is' },
              { id: 'return', label: 'Return to Supplier', value: 'return' },
              { id: 'other_disp', label: 'Other', value: 'other' },
            ],
          },
        },
        {
          id: 'corrective_action',
          type: 'long_text',
          label: 'Corrective Action',
          required: false,
          properties: { placeholder: 'Describe corrective actions taken' },
        },
      ],
    },

    // ── 8. Complaint Report ─────────────────────────────────────────────
    {
      packFormId: 'complaint-report',
      title: 'Complaint Report',
      icon: 'MessageSquare',
      description:
        'Record and track complaints from customers, employees, contractors, or regulatory bodies.',
      settings: { ...complianceSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'complaint_title',
          type: 'short_text',
          label: 'Complaint Title',
          required: true,
          properties: { placeholder: 'Brief description of the complaint' },
        },
        {
          id: 'complaint_type',
          type: 'dropdown',
          label: 'Complaint Type',
          required: true,
          properties: {
            options: [
              { id: 'safety', label: 'Safety', value: 'safety' },
              { id: 'environmental', label: 'Environmental', value: 'environmental' },
              { id: 'quality', label: 'Quality', value: 'quality' },
              { id: 'service', label: 'Service', value: 'service' },
              { id: 'conduct', label: 'Conduct', value: 'conduct' },
              { id: 'other_ct', label: 'Other', value: 'other' },
            ],
          },
        },
        {
          id: 'complaint_source',
          type: 'dropdown',
          label: 'Source',
          required: true,
          properties: {
            options: [
              { id: 'customer', label: 'Customer', value: 'customer' },
              { id: 'employee', label: 'Employee', value: 'employee' },
              { id: 'contractor', label: 'Contractor', value: 'contractor' },
              { id: 'public', label: 'Public', value: 'public' },
              { id: 'regulator', label: 'Regulator', value: 'regulator' },
              { id: 'other_cs', label: 'Other', value: 'other' },
            ],
          },
        },
        {
          id: 'complainant_name',
          type: 'short_text',
          label: 'Complainant Name',
          required: false,
          properties: { placeholder: 'Name of the person making the complaint' },
        },
        {
          id: 'complainant_contact',
          type: 'short_text',
          label: 'Complainant Contact',
          required: false,
          properties: { placeholder: 'Phone or email' },
        },
        {
          id: 'received_date',
          type: 'date',
          label: 'Date Received',
          required: true,
          properties: {},
        },
        {
          id: 'complaint_description',
          type: 'long_text',
          label: 'Description',
          required: true,
          properties: { placeholder: 'Detailed description of the complaint' },
        },
        {
          id: 'priority',
          type: 'dropdown',
          label: 'Priority',
          required: true,
          properties: {
            options: [
              { id: 'low', label: 'Low', value: 'low' },
              { id: 'medium', label: 'Medium', value: 'medium' },
              { id: 'high', label: 'High', value: 'high' },
              { id: 'critical', label: 'Critical', value: 'critical' },
            ],
          },
        },
        {
          id: 'assigned_to',
          type: 'short_text',
          label: 'Assigned To',
          required: true,
          properties: { placeholder: 'Person responsible for investigation' },
        },
        {
          id: 'investigation',
          type: 'long_text',
          label: 'Investigation',
          required: false,
          properties: { placeholder: 'Investigation findings' },
        },
        {
          id: 'resolution',
          type: 'long_text',
          label: 'Resolution',
          required: false,
          properties: { placeholder: 'How the complaint was resolved' },
        },
      ],
    },

    // ── 9. Training Record ──────────────────────────────────────────────
    {
      packFormId: 'training-record',
      title: 'Training Record',
      icon: 'GraduationCap',
      description:
        'Record employee training, certifications, and competency assessments.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'employee_name',
          type: 'short_text',
          label: 'Employee Name',
          required: true,
          properties: { placeholder: 'Full name' },
        },
        {
          id: 'course_name',
          type: 'short_text',
          label: 'Course / Training Name',
          required: true,
          properties: { placeholder: 'e.g. Working at Heights, First Aid' },
        },
        {
          id: 'provider',
          type: 'short_text',
          label: 'Training Provider',
          required: false,
          properties: { placeholder: 'Name of RTO or training provider' },
        },
        {
          id: 'completion_date',
          type: 'date',
          label: 'Completion Date',
          required: true,
          properties: {},
        },
        {
          id: 'expiry_date',
          type: 'date',
          label: 'Expiry Date',
          description: 'When does the certification expire?',
          required: false,
          properties: {},
        },
        {
          id: 'certificate_number',
          type: 'short_text',
          label: 'Certificate Number',
          required: false,
          properties: { placeholder: 'Certificate or licence number' },
        },
        {
          id: 'is_mandatory',
          type: 'multiple_choice',
          label: 'Mandatory Training?',
          required: true,
          properties: {
            options: [
              { id: 'yes', label: 'Yes', value: 'yes' },
              { id: 'no', label: 'No', value: 'no' },
            ],
          },
        },
        {
          id: 'assessment_result',
          type: 'dropdown',
          label: 'Assessment Result',
          required: false,
          properties: {
            options: [
              { id: 'passed', label: 'Passed', value: 'passed' },
              { id: 'failed', label: 'Failed', value: 'failed' },
              { id: 'na', label: 'N/A', value: 'na' },
            ],
          },
        },
        {
          id: 'certificate_file',
          type: 'file_upload',
          label: 'Certificate Upload',
          required: false,
          properties: { acceptedFileTypes: ['.pdf', '.jpg', '.png'] },
        },
        {
          id: 'notes',
          type: 'long_text',
          label: 'Notes',
          required: false,
          properties: { placeholder: 'Additional notes' },
        },
      ],
    },

    // ── 10. Contractor Approval ─────────────────────────────────────────
    {
      packFormId: 'contractor-approval',
      title: 'Contractor Approval',
      icon: 'BadgeCheck',
      description:
        'Approve contractors for site access with licence, insurance, and compliance verification.',
      settings: { ...complianceSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'business_name',
          type: 'short_text',
          label: 'Business Name',
          required: true,
          properties: { placeholder: 'Contractor business name' },
        },
        {
          id: 'trading_name',
          type: 'short_text',
          label: 'Trading Name',
          required: false,
          properties: { placeholder: 'Trading name (if different)' },
        },
        {
          id: 'abn',
          type: 'short_text',
          label: 'ABN',
          required: true,
          properties: { placeholder: 'e.g. 12345678901' },
          validation: [
            {
              id: 'abn_pattern',
              type: 'pattern',
              value: '^\\d{11}$',
              message: 'Please enter a valid 11-digit ABN.',
            },
          ],
        },
        {
          id: 'contact_name',
          type: 'short_text',
          label: 'Contact Name',
          required: true,
          properties: { placeholder: 'Primary contact person' },
        },
        {
          id: 'contact_email',
          type: 'email',
          label: 'Contact Email',
          required: true,
          properties: { placeholder: 'email@example.com' },
        },
        {
          id: 'contact_phone',
          type: 'phone',
          label: 'Contact Phone',
          required: true,
          properties: { placeholder: '04XX XXX XXX' },
        },
        {
          id: 'services',
          type: 'long_text',
          label: 'Services Provided',
          required: true,
          properties: { placeholder: 'List the services this contractor provides' },
        },
        {
          id: 'public_liability',
          type: 'multiple_choice',
          label: 'Public Liability Insurance?',
          required: true,
          properties: {
            options: [
              { id: 'yes', label: 'Yes', value: 'yes' },
              { id: 'no', label: 'No', value: 'no' },
            ],
          },
        },
        {
          id: 'workers_comp',
          type: 'multiple_choice',
          label: "Workers' Compensation Insurance?",
          required: true,
          properties: {
            options: [
              { id: 'yes', label: 'Yes', value: 'yes' },
              { id: 'no', label: 'No', value: 'no' },
              { id: 'exempt', label: 'Exempt (sole trader)', value: 'exempt' },
            ],
          },
        },
        {
          id: 'licence_details',
          type: 'long_text',
          label: 'Licence Details',
          required: false,
          properties: { placeholder: 'List relevant licences (type, number, expiry)' },
        },
        {
          id: 'insurance_documents',
          type: 'file_upload',
          label: 'Insurance Certificates',
          required: false,
          properties: {
            acceptedFileTypes: ['.pdf', '.jpg', '.png'],
            allowMultiple: true,
          },
        },
        {
          id: 'induction_completed',
          type: 'multiple_choice',
          label: 'Site Induction Completed?',
          required: true,
          properties: {
            options: [
              { id: 'yes', label: 'Yes', value: 'yes' },
              { id: 'no', label: 'No', value: 'no' },
              { id: 'pending', label: 'Pending', value: 'pending' },
            ],
          },
        },
        {
          id: 'approval_expiry',
          type: 'date',
          label: 'Approval Expiry Date',
          required: true,
          properties: {},
        },
      ],
    },

    // ── 11. Meeting / Toolbox Talk ───────────────────────────────────────
    {
      packFormId: 'meeting-record',
      title: 'Meeting / Toolbox Talk',
      icon: 'Users',
      description:
        'Record safety meetings, toolbox talks, committee meetings, and incident reviews.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'meeting_title',
          type: 'short_text',
          label: 'Meeting Title',
          required: true,
          properties: { placeholder: 'e.g. Weekly Toolbox Talk — Manual Handling' },
        },
        {
          id: 'meeting_type',
          type: 'dropdown',
          label: 'Meeting Type',
          required: true,
          properties: {
            options: [
              { id: 'toolbox', label: 'Toolbox Talk', value: 'toolbox' },
              { id: 'safety_committee', label: 'Safety Committee', value: 'safety_committee' },
              { id: 'incident_review', label: 'Incident Review', value: 'incident_review' },
              { id: 'training', label: 'Training Session', value: 'training' },
              { id: 'management', label: 'Management Review', value: 'management' },
              { id: 'other_mt', label: 'Other', value: 'other' },
            ],
          },
        },
        {
          id: 'meeting_date',
          type: 'date',
          label: 'Date',
          required: true,
          properties: {},
        },
        {
          id: 'meeting_time',
          type: 'time',
          label: 'Time',
          required: false,
          properties: {},
        },
        {
          id: 'location',
          type: 'short_text',
          label: 'Location',
          required: true,
          properties: { placeholder: 'Meeting location' },
        },
        {
          id: 'facilitator',
          type: 'short_text',
          label: 'Facilitator',
          required: true,
          properties: { placeholder: 'Person conducting the meeting' },
        },
        {
          id: 'attendees',
          type: 'long_text',
          label: 'Attendees',
          required: true,
          properties: { placeholder: 'Names of attendees (one per line)' },
        },
        {
          id: 'agenda',
          type: 'long_text',
          label: 'Agenda / Topics',
          required: true,
          properties: { placeholder: 'Topics discussed' },
        },
        {
          id: 'minutes',
          type: 'long_text',
          label: 'Minutes / Notes',
          required: false,
          properties: { placeholder: 'Meeting minutes and key decisions' },
        },
        {
          id: 'action_items',
          type: 'long_text',
          label: 'Action Items',
          required: false,
          properties: { placeholder: 'Actions arising from this meeting' },
        },
      ],
    },

    // ── 12. Plant & Equipment Register ──────────────────────────────────
    {
      packFormId: 'plant-equipment',
      title: 'Plant & Equipment Register',
      icon: 'Cog',
      description:
        'Register and track workplace plant, equipment, vehicles, and machinery with maintenance schedules.',
      settings: { ...defaultSettings },
      theme: { ...defaultTheme },
      fields: [
        {
          id: 'asset_name',
          type: 'short_text',
          label: 'Asset Name',
          required: true,
          properties: { placeholder: 'e.g. Forklift #3, Air Compressor' },
        },
        {
          id: 'category',
          type: 'dropdown',
          label: 'Category',
          required: true,
          properties: {
            options: [
              { id: 'vehicle', label: 'Vehicle', value: 'vehicle' },
              { id: 'forklift', label: 'Forklift', value: 'forklift' },
              { id: 'crane', label: 'Crane / Lifting', value: 'crane' },
              { id: 'scaffold', label: 'Scaffold', value: 'scaffold' },
              { id: 'power_tool', label: 'Power Tool', value: 'power_tool' },
              { id: 'pressure_vessel', label: 'Pressure Vessel', value: 'pressure_vessel' },
              { id: 'electrical', label: 'Electrical Equipment', value: 'electrical' },
              { id: 'other_cat', label: 'Other', value: 'other' },
            ],
          },
        },
        {
          id: 'manufacturer',
          type: 'short_text',
          label: 'Manufacturer',
          required: false,
          properties: { placeholder: 'Equipment manufacturer' },
        },
        {
          id: 'model',
          type: 'short_text',
          label: 'Model',
          required: false,
          properties: { placeholder: 'Model number' },
        },
        {
          id: 'serial_number',
          type: 'short_text',
          label: 'Serial Number',
          required: false,
          properties: { placeholder: 'Serial or asset number' },
        },
        {
          id: 'purchase_date',
          type: 'date',
          label: 'Purchase / Commission Date',
          required: false,
          properties: {},
        },
        {
          id: 'equipment_location',
          type: 'short_text',
          label: 'Location',
          required: true,
          properties: { placeholder: 'Where is this equipment located?' },
        },
        {
          id: 'last_service_date',
          type: 'date',
          label: 'Last Service Date',
          required: false,
          properties: {},
        },
        {
          id: 'next_service_date',
          type: 'date',
          label: 'Next Service Date',
          required: false,
          properties: {},
        },
        {
          id: 'inspection_frequency',
          type: 'dropdown',
          label: 'Inspection Frequency',
          required: true,
          properties: {
            options: [
              { id: 'daily', label: 'Daily', value: 'daily' },
              { id: 'weekly', label: 'Weekly', value: 'weekly' },
              { id: 'monthly', label: 'Monthly', value: 'monthly' },
              { id: 'quarterly', label: 'Quarterly', value: 'quarterly' },
              { id: 'annually', label: 'Annually', value: 'annually' },
            ],
          },
        },
        {
          id: 'registration_number',
          type: 'short_text',
          label: 'Registration Number',
          required: false,
          properties: { placeholder: 'Vehicle/equipment registration' },
        },
        {
          id: 'registration_expiry',
          type: 'date',
          label: 'Registration Expiry',
          required: false,
          properties: {},
        },
        {
          id: 'notes',
          type: 'long_text',
          label: 'Notes',
          required: false,
          properties: { placeholder: 'Maintenance notes or special requirements' },
        },
      ],
    },
  ],

  // ────────────────────────────────────────────────────────────────────────
  // APPS
  // ────────────────────────────────────────────────────────────────────────
  apps: [
    // ── 1. Safety Management ────────────────────────────────────────────
    {
      packAppId: 'safety-management',
      name: 'Safety Management',
      description:
        'Centralised OHS management hub for incident reporting, injury tracking, hazard identification, safety meetings, and plant/equipment management.',
      settings: {},
      theme: {
        primaryColor: '#dc2626',
        backgroundColor: '#0f172a',
        textColor: '#f8fafc',
        fontFamily: 'Inter',
        borderRadius: 'medium',
      },
      forms: [
        { packFormId: 'incident-report', displayName: 'Incident Report', sortOrder: 1, isVisible: true },
        { packFormId: 'injury-record', displayName: 'Injury Record', sortOrder: 2, isVisible: true },
        { packFormId: 'hazard-identification', displayName: 'Hazard Identification', sortOrder: 3, isVisible: true },
        { packFormId: 'action-item', displayName: 'Action Items', sortOrder: 4, isVisible: true },
        { packFormId: 'meeting-record', displayName: 'Meetings & Toolbox Talks', sortOrder: 5, isVisible: true },
        { packFormId: 'plant-equipment', displayName: 'Plant & Equipment', sortOrder: 6, isVisible: true },
        { packFormId: 'contractor-approval', displayName: 'Contractor Approval', sortOrder: 7, isVisible: true },
        { packFormId: 'training-record', displayName: 'Training Records', sortOrder: 8, isVisible: true },
      ],
      customScreen: {
        enabled: true,
        html: `<div id="app"><div class="wrap"><div class="empty">Loading safety dashboard…</div></div></div>`,
        css: `
*{box-sizing:border-box;margin:0;padding:0}
#app{min-height:100vh;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--fl-text);-webkit-font-smoothing:antialiased;
  background:radial-gradient(1100px 640px at 12% -12%,color-mix(in srgb,var(--fl-accent) 15%,transparent),transparent 58%),radial-gradient(900px 620px at 112% 4%,color-mix(in srgb,var(--fl-accent) 8%,transparent),transparent 55%)}
.wrap{max-width:1080px;margin:0 auto;padding:30px 20px 56px}
.empty{padding:80px 20px;text-align:center;color:var(--fl-muted);font-size:15px}
.hd{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:26px}
.hd-l{display:flex;flex-direction:column;gap:5px;min-width:0}
.eyebrow{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--fl-accent);font-weight:700}
.hd h1{font-size:26px;font-weight:750;letter-spacing:-.02em;color:var(--fl-text)}
.hd-user{font-size:13px;color:var(--fl-muted)}
.btn-primary{background:var(--fl-accent);color:var(--fl-accent-contrast);border:0;padding:11px 18px;border-radius:12px;font:inherit;font-weight:650;font-size:14px;cursor:pointer;box-shadow:0 6px 20px color-mix(in srgb,var(--fl-accent) 35%,transparent);transition:transform .12s ease,box-shadow .12s ease}
.btn-primary:hover{transform:translateY(-1px);box-shadow:0 10px 26px color-mix(in srgb,var(--fl-accent) 45%,transparent)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(158px,1fr));gap:14px;margin-bottom:20px}
.stat{position:relative;padding:17px 18px;border:1px solid var(--fl-border);border-radius:16px;background:var(--fl-surface);box-shadow:var(--fl-shadow);overflow:hidden}
.stat::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--fl-accent)}
.stat-val{font-size:30px;font-weight:750;line-height:1;letter-spacing:-.02em;color:var(--fl-text)}
.stat-label{font-size:13px;color:var(--fl-muted);margin-top:8px;font-weight:550}
.stat-sub{font-size:12px;color:var(--fl-faint);margin-top:4px}
.t-good{color:var(--fl-good)}.t-warn{color:var(--fl-warn)}.t-bad{color:var(--fl-bad)}
.panels{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;margin-bottom:16px}
.panel{background:var(--fl-surface);border:1px solid var(--fl-border);border-radius:16px;box-shadow:var(--fl-shadow);overflow:hidden}
.panel-head{padding:16px 18px 2px}
.panel-head h2{font-size:14px;font-weight:650;color:var(--fl-text)}
.panel-body{padding:12px 18px 18px}
.bar-row{display:grid;grid-template-columns:112px 1fr 34px;align-items:center;gap:10px;margin:11px 0;font-size:13px}
.bar-name{color:var(--fl-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar-track{height:8px;background:var(--fl-track);border-radius:999px;overflow:hidden}
.bar-fill{height:100%;width:0;border-radius:999px;transition:width .95s cubic-bezier(.22,1,.36,1)}
.bar-val{text-align:right;color:var(--fl-faint);font-variant-numeric:tabular-nums}
.row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 0;border-top:1px solid var(--fl-border)}
.row:first-child{border-top:0}
.row-main{min-width:0}
.row-title{font-size:14px;font-weight:550;color:var(--fl-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row-meta{font-size:12px;color:var(--fl-faint);margin-top:2px}
.badge{font-size:11px;font-weight:650;padding:3px 9px;border-radius:999px;border:1px solid;white-space:nowrap}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:20px}
.qa{display:inline-flex;align-items:center;gap:8px;padding:10px 15px;border-radius:12px;border:1px solid var(--fl-border);background:var(--fl-surface);color:var(--fl-text);font:inherit;font-size:13px;font-weight:550;cursor:pointer;transition:border-color .12s,background .12s,transform .12s}
.qa:hover{border-color:var(--fl-accent);background:color-mix(in srgb,var(--fl-accent) 12%,transparent);transform:translateY(-1px)}
.empty-sm{padding:20px 4px;text-align:center;color:var(--fl-muted);font-size:13px}
.cta{margin-top:12px;background:color-mix(in srgb,var(--fl-accent) 15%,transparent);color:var(--fl-accent);border:1px solid color-mix(in srgb,var(--fl-accent) 40%,transparent);padding:8px 14px;border-radius:10px;font:inherit;font-size:12px;font-weight:600;cursor:pointer}
.cta:hover{background:color-mix(in srgb,var(--fl-accent) 25%,transparent)}
`,
        js: `(function(){
var FL=window.FormLogic;
function h(s){return FL.escapeHtml(s==null?'':String(s));}
function findForm(ctx,names){for(var n=0;n<names.length;n++){var t=String(names[n]).toLowerCase();for(var i=0;i<ctx.forms.length;i++){if(String(ctx.forms[i].displayName||'').toLowerCase()===t)return ctx.forms[i];}}return null;}
function fieldOptions(f,id){if(!f)return[];for(var i=0;i<f.fields.length;i++){var x=f.fields[i];if(x.id===id&&x.properties&&x.properties.options)return x.properties.options;}return[];}
function optLabels(f,id){var m={};var o=fieldOptions(f,id);for(var i=0;i<o.length;i++){m[o[i].value]=o[i].label;}return m;}
function ans(r,id){return r&&r.answers?r.answers[id]:undefined;}
function countBy(rs,id){var m={};for(var i=0;i<rs.length;i++){var v=ans(rs[i],id);if(v==null||v==='')continue;m[v]=(m[v]||0)+1;}return m;}
function parseDate(v){if(!v)return null;var d=new Date(v);return isNaN(d.getTime())?null:d;}
function startToday(){var d=new Date();d.setHours(0,0,0,0);return d;}
function fmtDate(v){var d=parseDate(v);if(!d)return '—';return d.toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'});}
function num(n){return (n||0).toLocaleString();}
var SEV={low:'var(--fl-good)',medium:'var(--fl-warn)',high:'color-mix(in srgb,var(--fl-warn),var(--fl-bad))',critical:'var(--fl-bad)'};
var RISK={Low:'var(--fl-good)',Medium:'var(--fl-warn)',High:'color-mix(in srgb,var(--fl-warn),var(--fl-bad))',Critical:'var(--fl-bad)'};
function bar(l,c,mx,col){var p=mx>0?Math.max(3,Math.round(c/mx*100)):0;return '<div class="bar-row"><span class="bar-name">'+h(l)+'</span><div class="bar-track"><div class="bar-fill" data-pct="'+p+'" style="background:'+col+'"></div></div><span class="bar-val">'+num(c)+'</span></div>';}
function stat(v,l,sub,tone){return '<div class="stat"><div class="stat-val">'+h(v)+'</div><div class="stat-label">'+h(l)+'</div>'+(sub!=null?'<div class="stat-sub'+(tone?' t-'+tone:'')+'">'+h(sub)+'</div>':'')+'</div>';}
function panel(t,b){return '<section class="panel"><div class="panel-head"><h2>'+h(t)+'</h2></div><div class="panel-body">'+b+'</div></section>';}
function badge(t,col){return '<span class="badge" style="color:'+col+';border-color:color-mix(in srgb,'+col+' 45%,transparent);background:color-mix(in srgb,'+col+' 16%,transparent)">'+h(t)+'</span>';}
function vbadge(v,labels,colors){if(v==null||v==='')return '';return badge(labels[v]||v,colors[v]||'var(--fl-muted)');}
function listRow(t,m,bd){return '<div class="row"><div class="row-main"><div class="row-title">'+h(t)+'</div><div class="row-meta">'+h(m)+'</div></div>'+(bd||'')+'</div>';}
function emptyBody(msg,fid,cta){var b='<div class="empty-sm">'+h(msg);if(fid){b+='<div><button class="cta" data-nav="'+h(fid)+'">'+h(cta||'Add one')+'</button></div>';}return b+'</div>';}
function optBars(f,fid,counts,colors){var o=fieldOptions(f,fid);var mx=0;for(var i=0;i<o.length;i++){var c=counts[o[i].value]||0;if(c>mx)mx=c;}var body='';var any=false;for(var i=0;i<o.length;i++){var c=counts[o[i].value]||0;body+=bar(o[i].label,c,mx,colors[o[i].value]||'var(--fl-muted)');if(c>0)any=true;}return {body:body,any:any};}
async function recs(f){return f?await FL.records(f.formId,{limit:500}).catch(function(){return[];}):[];}
async function main(){
var root=document.getElementById('app');
var ctx;try{ctx=await FL.context();}catch(e){root.innerHTML='<div class="wrap"><div class="empty">Could not load dashboard.</div></div>';return;}
var user=await FL.currentUser().catch(function(){return null;});
var incF=findForm(ctx,['Incident Report']);
var injF=findForm(ctx,['Injury Record']);
var hazF=findForm(ctx,['Hazard Identification']);
var actF=findForm(ctx,['Action Items','Action Item']);
var meetF=findForm(ctx,['Meetings & Toolbox Talks','Meeting / Toolbox Talk']);
var contF=findForm(ctx,['Contractor Approval']);
var inc=await recs(incF),inj=await recs(injF),haz=await recs(hazF),act=await recs(actF);
var sevC=countBy(inc,'severity');
var highCrit=(sevC.high||0)+(sevC.critical||0);
var riskC=countBy(haz,'risk_level');
var highRisk=(riskC.High||0)+(riskC.Critical||0);
var lostTime=0;for(var i=0;i<inj.length;i++){if(ans(inj[i],'lost_time')==='yes')lostTime++;}
var today=startToday();var overdue=0;for(var i=0;i<act.length;i++){var d=parseDate(ans(act[i],'due_date'));if(d&&d<today)overdue++;}
var html='';
html+='<header class="hd"><div class="hd-l"><div class="eyebrow">'+h(ctx.appName||'Safety Management')+'</div><h1>Safety Command Center</h1><div class="hd-user">'+(user&&user.name?'Signed in as '+h(user.name):'Workplace health and safety overview')+'</div></div>';
if(incF)html+='<button class="btn-primary" data-nav="'+h(incF.formId)+'">+ Report Incident</button>';
html+='</header>';
html+='<div class="stats">';
html+=stat(num(inc.length),'Incidents Logged',highCrit+' high / critical',highCrit>0?'warn':'good');
html+=stat(num(highCrit),'High / Critical','severity high or above',highCrit>0?'bad':'good');
html+=stat(num(haz.length),'Open Hazards',highRisk+' high-risk',highRisk>0?'warn':'good');
html+=stat(num(overdue),'Overdue Actions',act.length+' actions total',overdue>0?'bad':'good');
html+=stat(num(lostTime),'Lost-Time Injuries',inj.length+' injuries logged',lostTime>0?'warn':'good');
html+='</div>';
html+='<div class="panels">';
var sb=optBars(incF,'severity',sevC,SEV);
html+=panel('Incidents by Severity',sb.any?sb.body:emptyBody('No incidents reported yet.',incF?incF.formId:'','Report an incident'));
var sevL=optLabels(incF,'severity');var rb='';
if(inc.length){for(var i=0;i<Math.min(6,inc.length);i++){var r=inc[i];rb+=listRow(ans(r,'incident_title')||'Untitled incident',fmtDate(ans(r,'incident_date'))+' · '+(ans(r,'location')||'—'),vbadge(ans(r,'severity'),sevL,SEV));}}else rb=emptyBody('No incidents reported yet.',incF?incF.formId:'','Report an incident');
html+=panel('Recent Incidents',rb);
html+='</div>';
html+='<div class="panels">';
var order=['Critical','High','Medium','Low'];var mxR=0;for(var i=0;i<order.length;i++){if((riskC[order[i]]||0)>mxR)mxR=riskC[order[i]]||0;}
var hb='';var hany=false;for(var i=0;i<order.length;i++){var c=riskC[order[i]]||0;hb+=bar(order[i],c,mxR,RISK[order[i]]);if(c>0)hany=true;}
html+=panel('Hazards by Risk Level',hany?hb:emptyBody('No hazards recorded yet.',hazF?hazF.formId:'','Report a hazard'));
var priL=optLabels(actF,'priority');var due=[];for(var i=0;i<act.length;i++){var d=parseDate(ans(act[i],'due_date'));if(d)due.push({r:act[i],d:d});}
due.sort(function(a,b){return a.d-b.d;});
var ab='';if(due.length){for(var i=0;i<Math.min(6,due.length);i++){var r=due[i].r;var od=due[i].d<today;ab+=listRow(ans(r,'action_title')||'Action',(od?'Overdue · ':'Due ')+fmtDate(ans(r,'due_date'))+' · '+(ans(r,'assigned_to')||'Unassigned'),vbadge(ans(r,'priority'),priL,SEV));}}else ab=emptyBody('No open actions.',actF?actF.formId:'','Create an action');
html+=panel('Actions Due Soon',ab);
html+='</div>';
var qa=[[incF,'Report Incident'],[injF,'Log Injury'],[hazF,'Report Hazard'],[actF,'New Action'],[meetF,'Toolbox Talk'],[contF,'Approve Contractor']];
var qh='';for(var i=0;i<qa.length;i++){if(qa[i][0])qh+='<button class="qa" data-nav="'+h(qa[i][0].formId)+'">'+h(qa[i][1])+'</button>';}
if(qh)html+='<div class="actions">'+qh+'</div>';
root.innerHTML='<div class="wrap">'+html+'</div>';
var bs=root.querySelectorAll('[data-nav]');for(var i=0;i<bs.length;i++){(function(el){el.addEventListener('click',function(){FL.navigate(el.getAttribute('data-nav'));});})(bs[i]);}
requestAnimationFrame(function(){requestAnimationFrame(function(){var el=root.querySelectorAll('.bar-fill');for(var i=0;i<el.length;i++){el[i].style.width=(el[i].getAttribute('data-pct')||0)+'%';}});});
}
main();
})();`,
      },
      roles: [
        {
          name: 'Safety Officer',
          description: 'Safety team with full access to all OHS forms.',
          permissions: [
            { packFormId: 'incident-report', permission: 'submit_responses' },
            { packFormId: 'incident-report', permission: 'view_all_responses' },
            { packFormId: 'incident-report', permission: 'edit_responses' },
            { packFormId: 'incident-report', permission: 'export_responses' },
            { packFormId: 'injury-record', permission: 'submit_responses' },
            { packFormId: 'injury-record', permission: 'view_all_responses' },
            { packFormId: 'injury-record', permission: 'edit_responses' },
            { packFormId: 'injury-record', permission: 'export_responses' },
            { packFormId: 'hazard-identification', permission: 'submit_responses' },
            { packFormId: 'hazard-identification', permission: 'view_all_responses' },
            { packFormId: 'hazard-identification', permission: 'edit_responses' },
            { packFormId: 'hazard-identification', permission: 'export_responses' },
            { packFormId: 'action-item', permission: 'submit_responses' },
            { packFormId: 'action-item', permission: 'view_all_responses' },
            { packFormId: 'action-item', permission: 'edit_responses' },
            { packFormId: 'action-item', permission: 'export_responses' },
            { packFormId: 'meeting-record', permission: 'submit_responses' },
            { packFormId: 'meeting-record', permission: 'view_all_responses' },
            { packFormId: 'meeting-record', permission: 'edit_responses' },
            { packFormId: 'meeting-record', permission: 'export_responses' },
            { packFormId: 'plant-equipment', permission: 'submit_responses' },
            { packFormId: 'plant-equipment', permission: 'view_all_responses' },
            { packFormId: 'plant-equipment', permission: 'edit_responses' },
            { packFormId: 'plant-equipment', permission: 'export_responses' },
            { packFormId: 'contractor-approval', permission: 'submit_responses' },
            { packFormId: 'contractor-approval', permission: 'view_all_responses' },
            { packFormId: 'contractor-approval', permission: 'edit_responses' },
            { packFormId: 'contractor-approval', permission: 'export_responses' },
            { packFormId: 'training-record', permission: 'submit_responses' },
            { packFormId: 'training-record', permission: 'view_all_responses' },
            { packFormId: 'training-record', permission: 'edit_responses' },
            { packFormId: 'training-record', permission: 'export_responses' },
          ],
        },
        {
          name: 'Worker',
          description: 'Workers who can submit reports and view their own submissions.',
          permissions: [
            { packFormId: 'incident-report', permission: 'submit_responses' },
            { packFormId: 'incident-report', permission: 'view_own_responses' },
            { packFormId: 'hazard-identification', permission: 'submit_responses' },
            { packFormId: 'hazard-identification', permission: 'view_own_responses' },
            { packFormId: 'meeting-record', permission: 'view_own_responses' },
            { packFormId: 'training-record', permission: 'view_own_responses' },
          ],
        },
        {
          name: 'Manager',
          description: 'Managers with view and edit access across all OHS forms.',
          permissions: [
            { packFormId: 'incident-report', permission: 'submit_responses' },
            { packFormId: 'incident-report', permission: 'view_all_responses' },
            { packFormId: 'incident-report', permission: 'edit_responses' },
            { packFormId: 'injury-record', permission: 'view_all_responses' },
            { packFormId: 'injury-record', permission: 'edit_responses' },
            { packFormId: 'hazard-identification', permission: 'submit_responses' },
            { packFormId: 'hazard-identification', permission: 'view_all_responses' },
            { packFormId: 'hazard-identification', permission: 'edit_responses' },
            { packFormId: 'action-item', permission: 'submit_responses' },
            { packFormId: 'action-item', permission: 'view_all_responses' },
            { packFormId: 'action-item', permission: 'edit_responses' },
            { packFormId: 'meeting-record', permission: 'submit_responses' },
            { packFormId: 'meeting-record', permission: 'view_all_responses' },
            { packFormId: 'meeting-record', permission: 'edit_responses' },
            { packFormId: 'plant-equipment', permission: 'view_all_responses' },
            { packFormId: 'contractor-approval', permission: 'view_all_responses' },
            { packFormId: 'training-record', permission: 'view_all_responses' },
          ],
        },
      ],
    },

    // ── 2. Quality & Compliance ─────────────────────────────────────────
    {
      packAppId: 'quality-compliance',
      name: 'Quality & Compliance',
      description:
        'Quality management hub for audits, corrective actions, non-conformance tracking, complaint management, and training compliance.',
      settings: {},
      theme: {
        primaryColor: '#2563eb',
        backgroundColor: '#0f172a',
        textColor: '#f8fafc',
        fontFamily: 'Inter',
        borderRadius: 'medium',
      },
      forms: [
        { packFormId: 'audit-report', displayName: 'Audit Reports', sortOrder: 1, isVisible: true },
        { packFormId: 'car', displayName: 'Corrective Actions', sortOrder: 2, isVisible: true },
        { packFormId: 'ncr', displayName: 'Non-Conformances', sortOrder: 3, isVisible: true },
        { packFormId: 'complaint-report', displayName: 'Complaints', sortOrder: 4, isVisible: true },
        { packFormId: 'action-item', displayName: 'Action Items', sortOrder: 5, isVisible: true },
        { packFormId: 'training-record', displayName: 'Training Records', sortOrder: 6, isVisible: true },
        { packFormId: 'contractor-approval', displayName: 'Contractor Approval', sortOrder: 7, isVisible: true },
      ],
      customScreen: {
        enabled: true,
        html: `<div id="app"><div class="wrap"><div class="empty">Loading quality dashboard…</div></div></div>`,
        css: `
*{box-sizing:border-box;margin:0;padding:0}
#app{min-height:100vh;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--fl-text);-webkit-font-smoothing:antialiased;
  background:radial-gradient(1100px 640px at 12% -12%,color-mix(in srgb,var(--fl-accent) 15%,transparent),transparent 58%),radial-gradient(900px 620px at 112% 4%,color-mix(in srgb,var(--fl-accent) 8%,transparent),transparent 55%)}
.wrap{max-width:1080px;margin:0 auto;padding:30px 20px 56px}
.empty{padding:80px 20px;text-align:center;color:var(--fl-muted);font-size:15px}
.hd{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:26px}
.hd-l{display:flex;flex-direction:column;gap:5px;min-width:0}
.eyebrow{font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--fl-accent);font-weight:700}
.hd h1{font-size:26px;font-weight:750;letter-spacing:-.02em;color:var(--fl-text)}
.hd-user{font-size:13px;color:var(--fl-muted)}
.btn-primary{background:var(--fl-accent);color:var(--fl-accent-contrast);border:0;padding:11px 18px;border-radius:12px;font:inherit;font-weight:650;font-size:14px;cursor:pointer;box-shadow:0 6px 20px color-mix(in srgb,var(--fl-accent) 35%,transparent);transition:transform .12s ease,box-shadow .12s ease}
.btn-primary:hover{transform:translateY(-1px);box-shadow:0 10px 26px color-mix(in srgb,var(--fl-accent) 45%,transparent)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(158px,1fr));gap:14px;margin-bottom:20px}
.stat{position:relative;padding:17px 18px;border:1px solid var(--fl-border);border-radius:16px;background:var(--fl-surface);box-shadow:var(--fl-shadow);overflow:hidden}
.stat::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--fl-accent)}
.stat-val{font-size:30px;font-weight:750;line-height:1;letter-spacing:-.02em;color:var(--fl-text)}
.stat-label{font-size:13px;color:var(--fl-muted);margin-top:8px;font-weight:550}
.stat-sub{font-size:12px;color:var(--fl-faint);margin-top:4px}
.t-good{color:var(--fl-good)}.t-warn{color:var(--fl-warn)}.t-bad{color:var(--fl-bad)}
.panels{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;margin-bottom:16px}
.panel{background:var(--fl-surface);border:1px solid var(--fl-border);border-radius:16px;box-shadow:var(--fl-shadow);overflow:hidden}
.panel-head{padding:16px 18px 2px}
.panel-head h2{font-size:14px;font-weight:650;color:var(--fl-text)}
.panel-body{padding:12px 18px 18px}
.bar-row{display:grid;grid-template-columns:112px 1fr 34px;align-items:center;gap:10px;margin:11px 0;font-size:13px}
.bar-name{color:var(--fl-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar-track{height:8px;background:var(--fl-track);border-radius:999px;overflow:hidden}
.bar-fill{height:100%;width:0;border-radius:999px;transition:width .95s cubic-bezier(.22,1,.36,1)}
.bar-val{text-align:right;color:var(--fl-faint);font-variant-numeric:tabular-nums}
.row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 0;border-top:1px solid var(--fl-border)}
.row:first-child{border-top:0}
.row-main{min-width:0}
.row-title{font-size:14px;font-weight:550;color:var(--fl-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row-meta{font-size:12px;color:var(--fl-faint);margin-top:2px}
.badge{font-size:11px;font-weight:650;padding:3px 9px;border-radius:999px;border:1px solid;white-space:nowrap}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:20px}
.qa{display:inline-flex;align-items:center;gap:8px;padding:10px 15px;border-radius:12px;border:1px solid var(--fl-border);background:var(--fl-surface);color:var(--fl-text);font:inherit;font-size:13px;font-weight:550;cursor:pointer;transition:border-color .12s,background .12s,transform .12s}
.qa:hover{border-color:var(--fl-accent);background:color-mix(in srgb,var(--fl-accent) 12%,transparent);transform:translateY(-1px)}
.empty-sm{padding:20px 4px;text-align:center;color:var(--fl-muted);font-size:13px}
.cta{margin-top:12px;background:color-mix(in srgb,var(--fl-accent) 15%,transparent);color:var(--fl-accent);border:1px solid color-mix(in srgb,var(--fl-accent) 40%,transparent);padding:8px 14px;border-radius:10px;font:inherit;font-size:12px;font-weight:600;cursor:pointer}
.cta:hover{background:color-mix(in srgb,var(--fl-accent) 25%,transparent)}
`,
        js: `(function(){
var FL=window.FormLogic;
function h(s){return FL.escapeHtml(s==null?'':String(s));}
function findForm(ctx,names){for(var n=0;n<names.length;n++){var t=String(names[n]).toLowerCase();for(var i=0;i<ctx.forms.length;i++){if(String(ctx.forms[i].displayName||'').toLowerCase()===t)return ctx.forms[i];}}return null;}
function fieldOptions(f,id){if(!f)return[];for(var i=0;i<f.fields.length;i++){var x=f.fields[i];if(x.id===id&&x.properties&&x.properties.options)return x.properties.options;}return[];}
function optLabels(f,id){var m={};var o=fieldOptions(f,id);for(var i=0;i<o.length;i++){m[o[i].value]=o[i].label;}return m;}
function ans(r,id){return r&&r.answers?r.answers[id]:undefined;}
function countBy(rs,id){var m={};for(var i=0;i<rs.length;i++){var v=ans(rs[i],id);if(v==null||v==='')continue;m[v]=(m[v]||0)+1;}return m;}
function parseDate(v){if(!v)return null;var d=new Date(v);return isNaN(d.getTime())?null:d;}
function startToday(){var d=new Date();d.setHours(0,0,0,0);return d;}
function fmtDate(v){var d=parseDate(v);if(!d)return '—';return d.toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'});}
function num(n){return (n||0).toLocaleString();}
var NSEV={minor:'var(--fl-good)',major:'var(--fl-warn)',critical:'var(--fl-bad)'};
var FIND={observation:'var(--fl-muted)',minor:'var(--fl-warn)',major:'color-mix(in srgb,var(--fl-warn),var(--fl-bad))',critical:'var(--fl-bad)',opportunity:'var(--fl-good)'};
var PRI={low:'var(--fl-good)',medium:'var(--fl-warn)',high:'color-mix(in srgb,var(--fl-warn),var(--fl-bad))',critical:'var(--fl-bad)'};
function bar(l,c,mx,col){var p=mx>0?Math.max(3,Math.round(c/mx*100)):0;return '<div class="bar-row"><span class="bar-name">'+h(l)+'</span><div class="bar-track"><div class="bar-fill" data-pct="'+p+'" style="background:'+col+'"></div></div><span class="bar-val">'+num(c)+'</span></div>';}
function stat(v,l,sub,tone){return '<div class="stat"><div class="stat-val">'+h(v)+'</div><div class="stat-label">'+h(l)+'</div>'+(sub!=null?'<div class="stat-sub'+(tone?' t-'+tone:'')+'">'+h(sub)+'</div>':'')+'</div>';}
function panel(t,b){return '<section class="panel"><div class="panel-head"><h2>'+h(t)+'</h2></div><div class="panel-body">'+b+'</div></section>';}
function badge(t,col){return '<span class="badge" style="color:'+col+';border-color:color-mix(in srgb,'+col+' 45%,transparent);background:color-mix(in srgb,'+col+' 16%,transparent)">'+h(t)+'</span>';}
function vbadge(v,labels,colors){if(v==null||v==='')return '';return badge(labels[v]||v,colors[v]||'var(--fl-muted)');}
function listRow(t,m,bd){return '<div class="row"><div class="row-main"><div class="row-title">'+h(t)+'</div><div class="row-meta">'+h(m)+'</div></div>'+(bd||'')+'</div>';}
function emptyBody(msg,fid,cta){var b='<div class="empty-sm">'+h(msg);if(fid){b+='<div><button class="cta" data-nav="'+h(fid)+'">'+h(cta||'Add one')+'</button></div>';}return b+'</div>';}
function optBars(f,fid,counts,colors){var o=fieldOptions(f,fid);var mx=0;for(var i=0;i<o.length;i++){var c=counts[o[i].value]||0;if(c>mx)mx=c;}var body='';var any=false;for(var i=0;i<o.length;i++){var c=counts[o[i].value]||0;body+=bar(o[i].label,c,mx,colors[o[i].value]||'var(--fl-muted)');if(c>0)any=true;}return {body:body,any:any};}
async function recs(f){return f?await FL.records(f.formId,{limit:500}).catch(function(){return[];}):[];}
async function main(){
var root=document.getElementById('app');
var ctx;try{ctx=await FL.context();}catch(e){root.innerHTML='<div class="wrap"><div class="empty">Could not load dashboard.</div></div>';return;}
var user=await FL.currentUser().catch(function(){return null;});
var audF=findForm(ctx,['Audit Reports','Audit Report']);
var carF=findForm(ctx,['Corrective Actions','Corrective Action Request']);
var ncrF=findForm(ctx,['Non-Conformances','Non-Conformance Report']);
var cmpF=findForm(ctx,['Complaints','Complaint Report']);
var trnF=findForm(ctx,['Training Records','Training Record']);
var contF=findForm(ctx,['Contractor Approval']);
var aud=await recs(audF),car=await recs(carF),ncr=await recs(ncrF),cmp=await recs(cmpF),trn=await recs(trnF);
var needCA=0;for(var i=0;i<aud.length;i++){if(ans(aud[i],'corrective_actions_required')==='yes')needCA++;}
var today=startToday();var carOver=0;for(var i=0;i<car.length;i++){var d=parseDate(ans(car[i],'due_date'));if(d&&d<today)carOver++;}
var ncrSev=countBy(ncr,'severity');var ncrCrit=ncrSev.critical||0;
var findC=countBy(aud,'finding_severity');
var cmpPr=countBy(cmp,'priority');var cmpHigh=(cmpPr.high||0)+(cmpPr.critical||0);
var in30=new Date(today.getTime());in30.setDate(in30.getDate()+30);
var expired=0,expSoon=0;for(var i=0;i<trn.length;i++){var d=parseDate(ans(trn[i],'expiry_date'));if(!d)continue;if(d<today)expired++;else if(d<=in30)expSoon++;}
var certAttn=expired+expSoon;
var html='';
html+='<header class="hd"><div class="hd-l"><div class="eyebrow">'+h(ctx.appName||'Quality & Compliance')+'</div><h1>Quality Control Center</h1><div class="hd-user">'+(user&&user.name?'Signed in as '+h(user.name):'Audits, non-conformances and compliance')+'</div></div>';
if(audF)html+='<button class="btn-primary" data-nav="'+h(audF.formId)+'">+ New Audit</button>';
html+='</header>';
html+='<div class="stats">';
html+=stat(num(aud.length),'Audits Completed',needCA+' need corrective action',needCA>0?'warn':'good');
html+=stat(num(car.length),'Corrective Actions',carOver+' overdue',carOver>0?'bad':'good');
html+=stat(num(ncr.length),'Non-Conformances',ncrCrit+' critical',ncrCrit>0?'bad':(ncr.length?'warn':'good'));
html+=stat(num(cmp.length),'Complaints',cmpHigh+' high priority',cmpHigh>0?'warn':'good');
html+=stat(num(certAttn),'Certs Expiring',expired+' expired',expired>0?'bad':(expSoon?'warn':'good'));
html+='</div>';
html+='<div class="panels">';
var nb=optBars(ncrF,'severity',ncrSev,NSEV);
html+=panel('Non-Conformances by Severity',nb.any?nb.body:emptyBody('No non-conformances logged yet.',ncrF?ncrF.formId:'','Log an NCR'));
var atL=optLabels(audF,'audit_type');var fsL=optLabels(audF,'finding_severity');var rb='';
if(aud.length){for(var i=0;i<Math.min(6,aud.length);i++){var r=aud[i];rb+=listRow(ans(r,'audit_title')||'Untitled audit',fmtDate(ans(r,'audit_date'))+' · '+(atL[ans(r,'audit_type')]||'Audit'),vbadge(ans(r,'finding_severity'),fsL,FIND));}}else rb=emptyBody('No audits recorded yet.',audF?audF.formId:'','Start an audit');
html+=panel('Recent Audits',rb);
html+='</div>';
html+='<div class="panels">';
var fb=optBars(audF,'finding_severity',findC,FIND);
html+=panel('Audit Findings',fb.any?fb.body:emptyBody('No audit findings yet.',audF?audF.formId:'','Start an audit'));
var priL=optLabels(carF,'priority');var due=[];for(var i=0;i<car.length;i++){var d=parseDate(ans(car[i],'due_date'));if(d)due.push({r:car[i],d:d});}
due.sort(function(a,b){return a.d-b.d;});
var cb='';if(due.length){for(var i=0;i<Math.min(6,due.length);i++){var r=due[i].r;var od=due[i].d<today;cb+=listRow(ans(r,'car_title')||'Corrective action',(od?'Overdue · ':'Due ')+fmtDate(ans(r,'due_date'))+' · '+(ans(r,'assigned_to')||'Unassigned'),vbadge(ans(r,'priority'),priL,PRI));}}else cb=emptyBody('No corrective actions open.',carF?carF.formId:'','Raise a CAR');
html+=panel('Corrective Actions Due',cb);
html+='</div>';
var qa=[[audF,'New Audit'],[carF,'Raise CAR'],[ncrF,'Log NCR'],[cmpF,'Log Complaint'],[trnF,'Add Training'],[contF,'Approve Contractor']];
var qh='';for(var i=0;i<qa.length;i++){if(qa[i][0])qh+='<button class="qa" data-nav="'+h(qa[i][0].formId)+'">'+h(qa[i][1])+'</button>';}
if(qh)html+='<div class="actions">'+qh+'</div>';
root.innerHTML='<div class="wrap">'+html+'</div>';
var bs=root.querySelectorAll('[data-nav]');for(var i=0;i<bs.length;i++){(function(el){el.addEventListener('click',function(){FL.navigate(el.getAttribute('data-nav'));});})(bs[i]);}
requestAnimationFrame(function(){requestAnimationFrame(function(){var el=root.querySelectorAll('.bar-fill');for(var i=0;i<el.length;i++){el[i].style.width=(el[i].getAttribute('data-pct')||0)+'%';}});});
}
main();
})();`,
      },
      roles: [
        {
          name: 'Quality Manager',
          description: 'Quality team with full access to all QMS forms.',
          permissions: [
            { packFormId: 'audit-report', permission: 'submit_responses' },
            { packFormId: 'audit-report', permission: 'view_all_responses' },
            { packFormId: 'audit-report', permission: 'edit_responses' },
            { packFormId: 'audit-report', permission: 'delete_responses' },
            { packFormId: 'audit-report', permission: 'export_responses' },
            { packFormId: 'car', permission: 'submit_responses' },
            { packFormId: 'car', permission: 'view_all_responses' },
            { packFormId: 'car', permission: 'edit_responses' },
            { packFormId: 'car', permission: 'delete_responses' },
            { packFormId: 'car', permission: 'export_responses' },
            { packFormId: 'ncr', permission: 'submit_responses' },
            { packFormId: 'ncr', permission: 'view_all_responses' },
            { packFormId: 'ncr', permission: 'edit_responses' },
            { packFormId: 'ncr', permission: 'delete_responses' },
            { packFormId: 'ncr', permission: 'export_responses' },
            { packFormId: 'complaint-report', permission: 'submit_responses' },
            { packFormId: 'complaint-report', permission: 'view_all_responses' },
            { packFormId: 'complaint-report', permission: 'edit_responses' },
            { packFormId: 'complaint-report', permission: 'delete_responses' },
            { packFormId: 'complaint-report', permission: 'export_responses' },
            { packFormId: 'action-item', permission: 'submit_responses' },
            { packFormId: 'action-item', permission: 'view_all_responses' },
            { packFormId: 'action-item', permission: 'edit_responses' },
            { packFormId: 'action-item', permission: 'export_responses' },
            { packFormId: 'training-record', permission: 'submit_responses' },
            { packFormId: 'training-record', permission: 'view_all_responses' },
            { packFormId: 'training-record', permission: 'edit_responses' },
            { packFormId: 'training-record', permission: 'export_responses' },
            { packFormId: 'contractor-approval', permission: 'submit_responses' },
            { packFormId: 'contractor-approval', permission: 'view_all_responses' },
            { packFormId: 'contractor-approval', permission: 'edit_responses' },
            { packFormId: 'contractor-approval', permission: 'export_responses' },
          ],
        },
        {
          name: 'Auditor',
          description: 'Internal or external auditors with audit and view access.',
          permissions: [
            { packFormId: 'audit-report', permission: 'submit_responses' },
            { packFormId: 'audit-report', permission: 'view_all_responses' },
            { packFormId: 'audit-report', permission: 'edit_responses' },
            { packFormId: 'car', permission: 'submit_responses' },
            { packFormId: 'car', permission: 'view_all_responses' },
            { packFormId: 'ncr', permission: 'submit_responses' },
            { packFormId: 'ncr', permission: 'view_all_responses' },
            { packFormId: 'action-item', permission: 'view_all_responses' },
          ],
        },
        {
          name: 'Team Member',
          description: 'Team members who can raise complaints and view their own records.',
          permissions: [
            { packFormId: 'complaint-report', permission: 'submit_responses' },
            { packFormId: 'complaint-report', permission: 'view_own_responses' },
            { packFormId: 'ncr', permission: 'submit_responses' },
            { packFormId: 'ncr', permission: 'view_own_responses' },
            { packFormId: 'action-item', permission: 'view_own_responses' },
            { packFormId: 'training-record', permission: 'view_own_responses' },
          ],
        },
      ],
    },
  ],
};
