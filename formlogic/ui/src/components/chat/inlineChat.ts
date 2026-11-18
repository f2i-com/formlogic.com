import { createContext } from 'react';

/** A workspace page can display the active account's existing chat in its layout. */
export const InlineChatMount = createContext<(node: HTMLDivElement | null) => void>(() => {});
