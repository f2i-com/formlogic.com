import type { PackData } from '../../lib/api';
import { financeOsPack } from './financeOsPack';
import { financeOsAuPack } from './financeOsAuPack';

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
];
