// Barrel kept minimal on purpose. Dashboard, FormsList and Settings are
// lazy-loaded in App.tsx (React.lazy) to keep them out of the eager entry chunk.
// Do NOT re-export them here — a static barrel import elsewhere would pull them
// back into the entry and undo the code-splitting. Import those pages directly
// from their own modules where needed.
export { Landing } from './Landing';
