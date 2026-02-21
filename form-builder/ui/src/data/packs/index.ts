import type { PackData } from '../../lib/api';
import { financeOsPack } from './financeOsPack';

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
    id: 'finance-os',
    name: 'Finance OS Pack',
    description:
      'Complete onboarding, compliance, and advisory workflow for RIAs, broker-dealers, and wealth managers. Includes 12 forms and 2 apps.',
    tags: ['finance', 'compliance', 'onboarding'],
    formCount: financeOsPack.forms.length,
    appCount: financeOsPack.apps?.length ?? 0,
    icon: '\uD83C\uDFE6', // 🏦
    pack: financeOsPack as unknown as PackData,
  },
];
