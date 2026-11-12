// Which page an address belongs to. The app remounts everything when the page changes (its error
// boundary is keyed by it), so the addresses inside one page must share a place: a SoftN app's
// sections, and the table its Data section has open, are one page, and it stays mounted while the
// address moves within it. An unsaved draft, the table list and its scroll are kept that way.
// Every other address is its own page. Kept apart from lib/softnApps so the first screen's code
// does not take that module's imports with it.

export const pagePlace = (pathname: string): string => pathname.replace(/^(\/apps\/[^/]+\/softn)\/.*$/, '$1');
