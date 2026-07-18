/** @jsxImportSource preact */
// The up-front card state: the honest 'Loading...' copy with a soft shimmer,
// so a slow relayed read against a remote desktop never leaves a card blank.
export function Loading() {
  return <p class="faint loading" role="status">Loading...</p>;
}
