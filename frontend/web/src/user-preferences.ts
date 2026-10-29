/** Browser preferences belong to the signed-in account on this server origin. */
export const preferencesChanged = 'wildstring:preferences-user-changed';
const legacyOwner = 'wildstring:preferences-legacy-owner';
const legacyKeys = [
  'wildstring-theme',
  'wildstring-playback-style',
  'wildstring:track-list-size',
  'wildstring-lyric-size',
  'wildstring:active_view',
  'wildstring:download-bitrate',
  'wildstring:download-any-network',
  'wildstring:offline-limit',
];
let account: string | null = null;
const memory = new Map<string, string>();
export function preferenceKey(key: string): string {
  return account ? `wildstring:user-preferences:${encodeURIComponent(account)}:${key}` : key;
}
export function readPreference(key: string): string | null {
  const scoped = preferenceKey(key);
  if (memory.has(scoped)) return memory.get(scoped)!;
  try {
    // Once claimed, old device-wide settings are migration input only.
    if (!account && localStorage.getItem(legacyOwner)) return null;
    return localStorage.getItem(scoped);
  } catch {
    return null;
  }
}
export function writePreference(key: string, value: string) {
  const scoped = preferenceKey(key);
  try {
    localStorage.setItem(scoped, value);
    memory.delete(scoped);
  } catch {
    memory.set(scoped, value);
  }
}
export function bindPreferences(userId: string | null) {
  if (account === userId) return;
  if (userId) {
    try {
      if (!localStorage.getItem(legacyOwner)) {
        for (const key of legacyKeys) {
          const value = localStorage.getItem(key);
          const scoped = `wildstring:user-preferences:${encodeURIComponent(userId)}:${key}`;
          if (value !== null && localStorage.getItem(scoped) === null)
            localStorage.setItem(scoped, value);
        }
        localStorage.setItem(legacyOwner, userId);
      }
    } catch {
      /* Preferences remain optional when browser storage is blocked. */
    }
  }
  account = userId;
  window.dispatchEvent(new Event(preferencesChanged));
}
