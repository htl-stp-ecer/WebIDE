import type { Flowchart } from './flowchart';
import { refreshContextMenus, updateOrientationOptions } from './menu-handlers';
import { setupFlowchartEffects } from './flowchart-effects';
import { observeThemeChange, readDarkMode } from './theme-utils';

export function initializeFlowchart(flow: Flowchart): void {
  flow.projectUUID = flow.route.snapshot.paramMap.get('uuid');

  refreshContextMenus(flow);
  updateOrientationOptions(flow);
  flow.langChangeSub = flow.translate.onLangChange.subscribe(() => {
    refreshContextMenus(flow);
    updateOrientationOptions(flow);
  });

  flow.historyManager.resetHistoryWithCurrentState();
  flow.canUndoSignal = flow.history.canUndo;
  flow.canRedoSignal = flow.history.canRedo;

  setupFlowchartEffects(flow);

  const observer = observeThemeChange(() => flow.isDarkMode.set(readDarkMode()));
  if (observer) {
    flow.themeObserver = observer;
  }
}
