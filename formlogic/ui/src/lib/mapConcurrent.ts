/** Bounded reads, preserving input order. A cancelled view starts no more work. */
export async function mapConcurrent<T, R>(
  items: readonly T[], read: (item: T) => Promise<R>,
  cancelled: () => boolean = () => false, limit = 4,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, Math.max(1, limit)) }, async () => {
    while (!cancelled()) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await read(items[index]);
    }
  }));
  return results;
}
