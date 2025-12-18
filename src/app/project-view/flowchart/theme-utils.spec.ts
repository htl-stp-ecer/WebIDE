import { persistViewToggleState, readStoredViewToggleState } from './theme-utils';

describe('theme-utils view toggle storage', () => {
  it('returns defaults when storage is empty', () => {
    spyOn(localStorage, 'getItem').and.returnValue(null);
    expect(readStoredViewToggleState({ timestamps: true })).toEqual({ timestamps: true });
  });

  it('merges stored boolean values', () => {
    spyOn(localStorage, 'getItem').and.returnValue(JSON.stringify({ timestamps: false, unityCanvas: true }));
    expect(readStoredViewToggleState({ timestamps: true, unityCanvas: false, tableEditor: false })).toEqual({
      timestamps: false,
      unityCanvas: true,
      tableEditor: false,
    });
  });

  it('ignores stored non-boolean values', () => {
    spyOn(localStorage, 'getItem').and.returnValue(JSON.stringify({ timestamps: 'nope', unityCanvas: 1 }));
    expect(readStoredViewToggleState({ timestamps: true, unityCanvas: false })).toEqual({ timestamps: true, unityCanvas: false });
  });

  it('persists value as json', () => {
    const setItemSpy = spyOn(localStorage, 'setItem');
    persistViewToggleState({ timestamps: false });
    expect(setItemSpy).toHaveBeenCalledWith('flowchartViewToggles', JSON.stringify({ timestamps: false }));
  });
});

