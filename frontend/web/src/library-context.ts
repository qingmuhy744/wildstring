let owner = '';
let selected = 'all';
let access = '';

export function bindLibraryUser(userId: string) {
  if (owner === userId) return;
  owner = userId;
  access = '';
  try {
    selected = localStorage.getItem(`wildstring:library:${owner}`) || 'all';
  } catch {
    selected = 'all';
  }
}

export function selectedLibrary() {
  return selected;
}
export function libraryUser() {
  return owner;
}

export function selectLibrary(id: string) {
  if (id === selected) return;
  selected = id;
  try {
    localStorage.setItem(`wildstring:library:${owner}`, id);
  } catch {
    /* Memory selection remains usable. */
  }
  window.dispatchEvent(new Event('wildstring:library-changed'));
}

export function observeLibraryAccess(value: string | null, expectedOwner: string) {
  if (!value || owner !== expectedOwner) return;
  const changed = access && access !== value;
  access = value;
  if (changed) window.dispatchEvent(new Event('wildstring:library-access-changed'));
}
