import type { Flowchart } from './flowchart';
import { NotificationService } from '../../services/NotificationService';

export function handleSave(flow: Flowchart): void {
  const mission = flow.missionState.currentMission();
  const projectId = flow.projectUUID;
  if (!mission || !projectId) {
    return;
  }
  flow.http.saveMission(projectId, mission).subscribe({
    error: error => NotificationService.showError('Could not save settings', String(error)),
  });
}
