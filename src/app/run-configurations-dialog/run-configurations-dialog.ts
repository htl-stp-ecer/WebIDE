import { Component, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpService, RunConfiguration } from '../services/http-service';
import { RunActionService } from '../services/run-action-service';

/**
 * PyCharm-style "Run/Debug Configurations" dialog. Lists every
 * configuration (builtin + user), lets the user pick one in the left
 * pane and edit it in the right pane. Save persists to the IDE backend
 * which writes ``run_configurations:`` in ``raccoon.project.yml`` —
 * the same file the ``raccoon run`` CLI reads.
 */
@Component({
  selector: 'app-run-configurations-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './run-configurations-dialog.html',
  styleUrl: './run-configurations-dialog.scss',
})
export class RunConfigurationsDialog {
  readonly open = signal(false);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  // Working copy: edited locally, only synced back on Save.
  readonly working = signal<RunConfiguration[]>([]);
  readonly selectedName = signal<string | null>(null);

  readonly selected = computed<RunConfiguration | null>(() => {
    const name = this.selectedName();
    if (!name) return null;
    return this.working().find(c => c.name === name) ?? null;
  });

  // Env-var editing as a textarea (KEY=VALUE per line) — easiest UX
  // for an MVP and matches how the CLI prints them.
  envText = '';
  argsText = '';

  constructor(
    private http: HttpService,
    readonly runAction: RunActionService,
  ) {}

  show(): void {
    this.error.set(null);
    // Snapshot the live configs so the dialog is independent until Save.
    const snapshot = this.runAction.runConfigurations().map(c => ({ ...c, args: [...c.args], env: { ...c.env } }));
    this.working.set(snapshot);
    const current = this.runAction.selectedRunConfigName();
    const initial = current && snapshot.some(c => c.name === current) ? current : (snapshot[0]?.name ?? null);
    this.select(initial);
    this.open.set(true);
  }

  close(): void {
    this.open.set(false);
  }

  select(name: string | null): void {
    this.selectedName.set(name);
    const cfg = this.selected();
    this.envText = cfg ? Object.entries(cfg.env).map(([k, v]) => `${k}=${v}`).join('\n') : '';
    this.argsText = cfg ? cfg.args.join(' ') : '';
  }

  addConfiguration(): void {
    let base = 'new-config';
    let i = 1;
    const names = new Set(this.working().map(c => c.name));
    while (names.has(base)) base = `new-config-${++i}`;
    const cfg: RunConfiguration = {
      name: base,
      description: '',
      target: 'auto',
      dev: false,
      no_calibrate: false,
      no_checkpoints: false,
      no_codegen: false,
      no_sync: false,
      record_localization: false,
      record_hz: null,
      args: [],
      env: {},
      builtin: false,
    };
    this.working.update(list => [...list, cfg]);
    this.select(cfg.name);
  }

  duplicateSelected(): void {
    const cfg = this.selected();
    if (!cfg) return;
    let newName = `${cfg.name}-copy`;
    const names = new Set(this.working().map(c => c.name));
    let i = 1;
    while (names.has(newName)) newName = `${cfg.name}-copy-${++i}`;
    const copy: RunConfiguration = { ...cfg, args: [...cfg.args], env: { ...cfg.env }, name: newName, builtin: false };
    this.working.update(list => [...list, copy]);
    this.select(newName);
  }

  removeSelected(): void {
    const cfg = this.selected();
    if (!cfg) return;
    if (cfg.builtin) {
      this.error.set(`Cannot remove builtin preset '${cfg.name}'`);
      return;
    }
    this.working.update(list => list.filter(c => c.name !== cfg.name));
    this.select(this.working()[0]?.name ?? null);
  }

  /**
   * Patch the selected configuration in the working copy. The signal-based
   * model rejects in-place mutation, so we splice in a fresh object.
   */
  patch<K extends keyof RunConfiguration>(key: K, value: RunConfiguration[K]): void {
    const cfg = this.selected();
    if (!cfg) return;
    this.working.update(list => list.map(c => c === cfg ? { ...c, [key]: value } : c));
  }

  onNameChange(newName: string): void {
    const cfg = this.selected();
    if (!cfg || cfg.builtin) return;
    const trimmed = newName.trim();
    if (!trimmed) return;
    this.working.update(list => list.map(c => c === cfg ? { ...c, name: trimmed } : c));
    this.selectedName.set(trimmed);
  }

  /** Parse the env textarea on demand — keeps the model clean of malformed entries. */
  private parseEnvText(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const raw of this.envText.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1);
      if (key) result[key] = value;
    }
    return result;
  }

  private parseArgs(): string[] {
    return this.argsText.split(/\s+/).map(s => s.trim()).filter(Boolean);
  }

  async save(): Promise<void> {
    const projectUuid = this.runAction.currentProjectUUID();
    if (!projectUuid) {
      this.error.set('No active project');
      return;
    }
    const cfg = this.selected();
    if (cfg) {
      // Flush the textareas back into the working copy before persisting.
      this.working.update(list => list.map(c => c === cfg ? { ...c, env: this.parseEnvText(), args: this.parseArgs() } : c));
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      // Server is the source of truth: PUT each non-builtin entry, then
      // DELETE anything that was removed.
      const original = this.runAction.runConfigurations();
      const current = this.working();
      const currentNames = new Set(current.map(c => c.name));
      for (const removed of original) {
        if (!removed.builtin && !currentNames.has(removed.name)) {
          await this.http.deleteRunConfiguration(projectUuid, removed.name).toPromise();
        }
      }
      for (const c of current) {
        if (c.builtin) continue;
        await this.http.upsertRunConfiguration(projectUuid, c).toPromise();
      }
      const fresh = await this.http.listRunConfigurations(projectUuid).toPromise();
      this.runAction.setRunConfigurations(fresh?.configurations ?? []);
      this.close();
    } catch (e: any) {
      this.error.set(e?.error?.detail ?? e?.message ?? String(e));
    } finally {
      this.busy.set(false);
    }
  }
}
