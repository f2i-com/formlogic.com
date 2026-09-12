import entries from '../data/starter-catalog.json';
import type { CatalogPack } from './api';
export const starterCatalog = entries;
export function browseStarters(search = '', category = '', tag = '', sort = 'popular', page = 1, limit = 12) {
  const query = search.toLowerCase().trim();
  const matching = (entries as CatalogPack[]).filter(pack =>
    (!query || [pack.name, pack.description, ...pack.tags].join(' ').toLowerCase().includes(query)) &&
    (!category || pack.category === category) && (!tag || pack.tags.includes(tag)));
  matching.sort((a,b) => sort === 'name' ? a.name.localeCompare(b.name) : Number(b.featured) - Number(a.featured) || a.name.localeCompare(b.name));
  return { packs:matching.slice((page-1)*limit,page*limit), totalPages:Math.max(1,Math.ceil(matching.length/limit)) };
}
