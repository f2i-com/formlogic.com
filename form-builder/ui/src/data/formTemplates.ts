import { v4 as uuidv4 } from 'uuid';
import type { FormField, FieldOption } from '../types/form';

export interface FormTemplate {
  id: string;
  name: string;
  description: string;
  category: 'business' | 'feedback' | 'events' | 'hr' | 'education' | 'finance' | 'other';
  icon: string;
  fields: Omit<FormField, 'id' | 'order'>[];
  estimatedTime?: string;
}

const createOption = (label: string): FieldOption => ({
  id: uuidv4(),
  label,
  value: label.toLowerCase().replace(/\s+/g, '_'),
});

export const formTemplates: FormTemplate[] = [
  {
    id: 'contact-form',
    name: 'Contact Form',
    description: 'Simple contact form for visitors to reach out',
    category: 'business',
    icon: 'Mail',
    estimatedTime: '1 min',
    fields: [
      {
        type: 'short_text',
        label: 'Full Name',
        placeholder: 'Enter your name',
        required: true,
        properties: {},
      },
      {
        type: 'email',
        label: 'Email Address',
        placeholder: 'your@email.com',
        required: true,
        properties: {},
      },
      {
        type: 'phone',
        label: 'Phone Number',
        placeholder: '',
        required: false,
        properties: {},
      },
      {
        type: 'dropdown',
        label: 'Subject',
        required: true,
        properties: {
          options: [
            createOption('General Inquiry'),
            createOption('Support Request'),
            createOption('Sales Question'),
            createOption('Partnership'),
            createOption('Other'),
          ],
        },
      },
      {
        type: 'long_text',
        label: 'Message',
        placeholder: 'How can we help you?',
        required: true,
        properties: {},
      },
    ],
  },
  {
    id: 'feedback-survey',
    name: 'Customer Feedback',
    description: 'Collect feedback about your product or service',
    category: 'feedback',
    icon: 'MessageCircle',
    estimatedTime: '3 min',
    fields: [
      {
        type: 'rating',
        label: 'Overall Satisfaction',
        description: 'How satisfied are you with our product/service?',
        required: true,
        properties: { maxStars: 5 },
      },
      {
        type: 'multiple_choice',
        label: 'How did you hear about us?',
        required: false,
        properties: {
          options: [
            createOption('Search Engine'),
            createOption('Social Media'),
            createOption('Friend/Colleague'),
            createOption('Advertisement'),
            createOption('Other'),
          ],
        },
      },
      {
        type: 'scale',
        label: 'Likelihood to Recommend',
        description: 'How likely are you to recommend us to a friend?',
        required: true,
        properties: {
          scaleStart: 0,
          scaleEnd: 10,
          scaleStartLabel: 'Not likely',
          scaleEndLabel: 'Very likely',
        },
      },
      {
        type: 'checkboxes',
        label: 'What do you like about us?',
        required: false,
        properties: {
          options: [
            createOption('Product Quality'),
            createOption('Customer Service'),
            createOption('Pricing'),
            createOption('Ease of Use'),
            createOption('Speed/Performance'),
          ],
        },
      },
      {
        type: 'long_text',
        label: 'Additional Comments',
        placeholder: 'Share any other feedback...',
        required: false,
        properties: {},
      },
    ],
  },
  {
    id: 'event-registration',
    name: 'Event Registration',
    description: 'Register attendees for your event',
    category: 'events',
    icon: 'CalendarDays',
    estimatedTime: '2 min',
    fields: [
      {
        type: 'short_text',
        label: 'Full Name',
        required: true,
        properties: {},
      },
      {
        type: 'email',
        label: 'Email Address',
        required: true,
        properties: {},
      },
      {
        type: 'phone',
        label: 'Phone Number',
        required: false,
        properties: {},
      },
      {
        type: 'short_text',
        label: 'Organization/Company',
        required: false,
        properties: {},
      },
      {
        type: 'dropdown',
        label: 'Ticket Type',
        required: true,
        properties: {
          options: [
            createOption('General Admission'),
            createOption('VIP'),
            createOption('Student'),
            createOption('Group (5+)'),
          ],
        },
      },
      {
        type: 'checkboxes',
        label: 'Sessions of Interest',
        description: 'Select the sessions you plan to attend',
        required: false,
        properties: {
          options: [
            createOption('Opening Keynote'),
            createOption('Workshop A'),
            createOption('Workshop B'),
            createOption('Networking Lunch'),
            createOption('Closing Session'),
          ],
        },
      },
      {
        type: 'long_text',
        label: 'Dietary Requirements',
        placeholder: 'Please let us know of any dietary restrictions...',
        required: false,
        properties: {},
      },
    ],
  },
  {
    id: 'job-application',
    name: 'Job Application',
    description: 'Collect job applications from candidates',
    category: 'hr',
    icon: 'Briefcase',
    estimatedTime: '5 min',
    fields: [
      {
        type: 'short_text',
        label: 'Full Name',
        required: true,
        properties: {},
      },
      {
        type: 'email',
        label: 'Email Address',
        required: true,
        properties: {},
      },
      {
        type: 'phone',
        label: 'Phone Number',
        required: true,
        properties: {},
      },
      {
        type: 'url',
        label: 'LinkedIn Profile',
        placeholder: 'https://linkedin.com/in/yourprofile',
        required: false,
        properties: {},
      },
      {
        type: 'dropdown',
        label: 'Position Applied For',
        required: true,
        properties: {
          options: [
            createOption('Software Engineer'),
            createOption('Product Manager'),
            createOption('Designer'),
            createOption('Marketing'),
            createOption('Sales'),
            createOption('Other'),
          ],
        },
      },
      {
        type: 'number',
        label: 'Years of Experience',
        required: true,
        properties: { min: 0, max: 50 },
      },
      {
        type: 'file_upload',
        label: 'Resume/CV',
        description: 'Upload your resume (PDF, DOC, DOCX)',
        required: true,
        properties: {
          acceptedFileTypes: ['.pdf', '.doc', '.docx'],
          maxFileSize: 5,
        },
      },
      {
        type: 'long_text',
        label: 'Cover Letter',
        description: 'Tell us why you would be a great fit',
        required: false,
        properties: {},
      },
      {
        type: 'date',
        label: 'Available Start Date',
        required: true,
        properties: {},
      },
    ],
  },
  {
    id: 'newsletter-signup',
    name: 'Newsletter Signup',
    description: 'Grow your email list with a simple signup form',
    category: 'business',
    icon: 'Newspaper',
    estimatedTime: '30 sec',
    fields: [
      {
        type: 'email',
        label: 'Email Address',
        placeholder: 'Enter your email',
        required: true,
        properties: {},
      },
      {
        type: 'short_text',
        label: 'First Name',
        placeholder: 'Your first name (optional)',
        required: false,
        properties: {},
      },
      {
        type: 'checkboxes',
        label: 'Topics of Interest',
        required: false,
        properties: {
          options: [
            createOption('Product Updates'),
            createOption('Industry News'),
            createOption('Tips & Tutorials'),
            createOption('Special Offers'),
          ],
        },
      },
    ],
  },
  {
    id: 'bug-report',
    name: 'Bug Report',
    description: 'Collect detailed bug reports from users',
    category: 'feedback',
    icon: 'Bug',
    estimatedTime: '3 min',
    fields: [
      {
        type: 'email',
        label: 'Your Email',
        required: true,
        properties: {},
      },
      {
        type: 'dropdown',
        label: 'Bug Severity',
        required: true,
        properties: {
          options: [
            createOption('Critical - System Unusable'),
            createOption('High - Major Feature Broken'),
            createOption('Medium - Feature Impaired'),
            createOption('Low - Minor Issue'),
          ],
        },
      },
      {
        type: 'short_text',
        label: 'Bug Summary',
        placeholder: 'Brief description of the issue',
        required: true,
        properties: {},
      },
      {
        type: 'long_text',
        label: 'Steps to Reproduce',
        description: 'Please describe the steps to reproduce this bug',
        required: true,
        properties: {},
      },
      {
        type: 'long_text',
        label: 'Expected Behavior',
        placeholder: 'What should have happened?',
        required: true,
        properties: {},
      },
      {
        type: 'long_text',
        label: 'Actual Behavior',
        placeholder: 'What actually happened?',
        required: true,
        properties: {},
      },
      {
        type: 'file_upload',
        label: 'Screenshots',
        description: 'Upload screenshots if applicable',
        required: false,
        properties: {
          acceptedFileTypes: ['.png', '.jpg', '.jpeg', '.gif'],
          maxFileSize: 10,
          allowMultiple: true,
        },
      },
      {
        type: 'short_text',
        label: 'Browser/Device',
        placeholder: 'e.g., Chrome 120 on Windows 11',
        required: false,
        properties: {},
      },
    ],
  },
  {
    id: 'course-evaluation',
    name: 'Course Evaluation',
    description: 'Get feedback on courses or training sessions',
    category: 'education',
    icon: 'GraduationCap',
    estimatedTime: '3 min',
    fields: [
      {
        type: 'short_text',
        label: 'Course Name',
        required: true,
        properties: {},
      },
      {
        type: 'short_text',
        label: 'Instructor Name',
        required: true,
        properties: {},
      },
      {
        type: 'rating',
        label: 'Overall Course Rating',
        required: true,
        properties: { maxStars: 5 },
      },
      {
        type: 'scale',
        label: 'Content Quality',
        description: 'How would you rate the quality of the course content?',
        required: true,
        properties: {
          scaleStart: 1,
          scaleEnd: 5,
          scaleStartLabel: 'Poor',
          scaleEndLabel: 'Excellent',
        },
      },
      {
        type: 'scale',
        label: 'Instructor Effectiveness',
        description: 'How effective was the instructor at teaching the material?',
        required: true,
        properties: {
          scaleStart: 1,
          scaleEnd: 5,
          scaleStartLabel: 'Poor',
          scaleEndLabel: 'Excellent',
        },
      },
      {
        type: 'multiple_choice',
        label: 'Course Pace',
        required: true,
        properties: {
          options: [
            createOption('Too Slow'),
            createOption('Just Right'),
            createOption('Too Fast'),
          ],
        },
      },
      {
        type: 'long_text',
        label: 'What did you like most?',
        required: false,
        properties: {},
      },
      {
        type: 'long_text',
        label: 'What could be improved?',
        required: false,
        properties: {},
      },
    ],
  },
  {
    id: 'rsvp-form',
    name: 'RSVP Form',
    description: 'Quick RSVP for events and gatherings',
    category: 'events',
    icon: 'PartyPopper',
    estimatedTime: '1 min',
    fields: [
      {
        type: 'short_text',
        label: 'Your Name',
        required: true,
        properties: {},
      },
      {
        type: 'email',
        label: 'Email Address',
        required: true,
        properties: {},
      },
      {
        type: 'multiple_choice',
        label: 'Will you attend?',
        required: true,
        properties: {
          options: [
            createOption('Yes, I will attend'),
            createOption('No, I cannot attend'),
            createOption('Maybe'),
          ],
        },
      },
      {
        type: 'number',
        label: 'Number of Guests',
        description: 'Including yourself',
        required: false,
        properties: { min: 1, max: 10 },
      },
      {
        type: 'long_text',
        label: 'Dietary Restrictions or Notes',
        required: false,
        properties: {},
      },
    ],
  },
];

export const templateCategories = [
  { id: 'all', label: 'All Templates', icon: 'LayoutGrid' },
  { id: 'business', label: 'Business', icon: 'Building' },
  { id: 'feedback', label: 'Feedback', icon: 'MessageCircle' },
  { id: 'events', label: 'Events', icon: 'CalendarDays' },
  { id: 'hr', label: 'HR & Recruiting', icon: 'Users' },
  { id: 'education', label: 'Education', icon: 'GraduationCap' },
] as const;
