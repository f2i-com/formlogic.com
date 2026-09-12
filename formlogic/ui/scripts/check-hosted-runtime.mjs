import { access } from 'node:fs/promises';
try { await access(new URL('../public/hosted-runtime/index.html', import.meta.url)); }
catch { throw new Error('Missing hosted app runtime. Run npm run build:hosted-runtime with the sibling softn.com dependencies installed, or restore the generated public/hosted-runtime build artifact.'); }
