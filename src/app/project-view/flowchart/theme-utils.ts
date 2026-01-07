export function readDarkMode(): boolean {
  try {
    const de = document.documentElement;
    const body = document.body;
    return !!(
      de?.classList?.contains('dark') ||
      body?.classList?.contains('dark') ||
      de?.classList?.contains('p-dark') ||
      body?.classList?.contains('p-dark')
    );
  } catch {
    return false;
  }
}

export function readStoredAutoLayout(): boolean {
  try {
    const stored = localStorage.getItem('useAutoLayout');
    return stored === null ? true : stored === 'true';
  } catch {
    return true;
  }
}

export function persistAutoLayout(value: boolean): void {
  try {
    localStorage.setItem('useAutoLayout', JSON.stringify(value));
  } catch {
    /* ignore storage failures */
  }
}

const VIEW_TOGGLE_STORAGE_KEY = 'flowchartViewToggles';

export function readStoredViewToggleState(defaults: Record<string, boolean>): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(VIEW_TOGGLE_STORAGE_KEY);
    if (!raw) return { ...defaults };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...defaults };

    const stored = parsed as Record<string, unknown>;
    const next: Record<string, boolean> = { ...defaults };
    for (const key of Object.keys(stored)) {
      const value = stored[key];
      if (typeof value === 'boolean') next[key] = value;
    }

    return next;
  } catch {
    return { ...defaults };
  }
}

export function persistViewToggleState(value: Record<string, boolean>): void {
  try {
    localStorage.setItem(VIEW_TOGGLE_STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* ignore storage failures */
  }
}

export function observeThemeChange(onChange: () => void): MutationObserver | undefined {
  try {
    const observer = new MutationObserver(onChange);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return observer;
  } catch {
    return undefined;
  }
}
