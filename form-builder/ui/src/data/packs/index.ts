import type { PackData } from '../../lib/api';
import { financeOsPack } from './financeOsPack';
import { financeOsAuPack } from './financeOsAuPack';
import { ohsQmsPack } from './ohsQmsPack';

export interface PackCatalogEntry {
  id: string;
  name: string;
  description: string;
  tags: string[];
  formCount: number;
  appCount: number;
  icon: string;
  pack: PackData;
}

export const packCatalog: PackCatalogEntry[] = [
  {
    id: 'finance-os-us',
    name: 'Finance OS (United States)',
    description:
      'Complete United States-focused onboarding, compliance, and advisory workflow for RIAs, broker-dealers, and wealth managers. Includes 12 forms and 2 apps.',
    tags: ['finance', 'compliance', 'onboarding', 'united-states'],
    formCount: financeOsPack.forms.length,
    appCount: financeOsPack.apps?.length ?? 0,
    icon: '\uD83C\uDFE6', // 🏦
    pack: financeOsPack as unknown as PackData,
  },
  {
    id: 'finance-os-au',
    name: 'Finance OS (Australia)',
    description:
      'Comprehensive advisory workflow for Australian AFSLs, covering client onboarding, Best Interest Duty compliance, superannuation, and AUSTRAC requirements. Includes 10 forms and 2 apps.',
    tags: ['finance', 'compliance', 'onboarding', 'australia', 'afsl'],
    formCount: financeOsAuPack.forms.length,
    appCount: financeOsAuPack.apps?.length ?? 0,
    icon: '\uD83E\uDD98', // 🦘
    pack: financeOsAuPack as unknown as PackData,
  },
  {
    id: 'ohs-qms',
    name: 'OHS & Quality Management',
    description:
      'Complete occupational health & safety and quality management system covering incident reporting, hazard identification, audits, corrective actions, NCRs, and training records. Aligned with ISO 45001 and ISO 9001. Includes 12 forms and 2 apps.',
    tags: ['safety', 'quality', 'ohs', 'iso-45001', 'iso-9001', 'compliance'],
    formCount: ohsQmsPack.forms.length,
    appCount: ohsQmsPack.apps?.length ?? 0,
    icon: '\u26D1\uFE0F', // ⛑️
    pack: ohsQmsPack as unknown as PackData,
  },
];
