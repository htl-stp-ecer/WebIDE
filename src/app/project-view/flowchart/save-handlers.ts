import type { Flowchart } from './flowchart';
import { NotificationService } from '../../services/NotificationService';

export function handleSave(flow: Flowchart): void {
  const mission = flow.missionState.currentMission();
  const projectId = flow.projectUUID;
  if (!mission || !projectId || !flow.historyManager.hasUnsavedChanges()) {
    return;
  }
  flow.setSaveStatus('saving');
  flow.http.saveMission(projectId, mission).subscribe({
    next: () => {
      flow.historyManager.markSaved();
      flow.setSaveStatus('saved');
      flow.invalidateProjectSimulationCache?.();
      flow.updatePlannedPathForMission?.(mission);
    },
    error: error => {
      flow.setSaveStatus('idle');
      NotificationService.showError('Could not save settings', String(error));
    },
  });
}
