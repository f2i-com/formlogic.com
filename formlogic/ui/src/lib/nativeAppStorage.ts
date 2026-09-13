// The parent owns persistence; an isolated app receives only its own bounded snapshot.
const LIMIT = 256 * 1024;
export function nativeAppStorage(slug: string) {
  const key = `formlogic:native-storage:${encodeURIComponent(slug)}`;
  function read(): Record<string, string> {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    if (raw.length > LIMIT) throw new Error('This app’s saved browser data is too large.');
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('This app’s saved browser data could not be read.');
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => entry[0].length <= 256 && typeof entry[1] === 'string'));
  }
  function mutate(input: Record<string, unknown>) {
    const entries = new Map(Object.entries(read()));
    if (input.operation === 'clear') entries.clear();
    else {
      if (typeof input.key !== 'string' || input.key.length > 256) throw new Error('Invalid storage key.');
      if (input.operation === 'remove') entries.delete(input.key);
      else if (input.operation === 'set' && typeof input.value === 'string' && input.value.length <= 30000) entries.set(input.key, input.value);
      else throw new Error('Invalid storage operation.');
    }
    const data = JSON.stringify(Object.fromEntries(entries));
    if (entries.size > 200 || data.length > LIMIT) throw new Error('This app has reached its browser storage limit.');
    localStorage.setItem(key, data);
    return { saved: true };
  }
  return { read, mutate };
}
