import { Component, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Dialog } from 'primeng/dialog';
import { Button } from 'primeng/button';
import { InputText } from 'primeng/inputtext';
import { Select } from 'primeng/select';
import { HttpService, RunConfiguration } from '../services/http-service';
import { RunActionService } from '../services/run-action-service';

/**
 * PyCharm-style "Run/Debug Configurations" dialog. Lists every
 * configuration (builtin + user), lets the user pick one in the left
 * pane and edit it in the right pane. Save persists to the IDE backend
 * which writes ``run_configurations:`` in ``raccoon.project.yml`` —
 * the same file the ``raccoon run`` CLI reads.
 *
 * Builtins (default, dev, simulated) are editable too: editing one
 * writes a user-defined entry that shadows the builtin in the merged
 * view. Removing that override surfaces the builtin again.
 */
@Component({
  selector: 'app-run-configurations-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, Dialog, Button, InputText, Select],
  templateUrl: './run-configurations-dialog.html',
  styleUrl: './run-configurations-dialog.scss',
})
export class RunConfigurationsDialog {
  readonly visible = signal(false);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  readonly targetOptions = [
    { label: 'Auto (remote if connected, else local)', value: 'auto' },
    { label: 'Local', value: 'local' },
    { label: 'Remote (Pi)', value: 'remote' },
    { label: 'Simulated (libstp)', value: 'simulated' },
  ];

  // Working copy: edited locally, only synced back on Save.
  readonly working = signal<RunConfiguration[]>([]);
  readonly selectedName = signal<string | null>(null);

  readonly selected = computed<RunConfiguration | null>(() => {
    const name = this.selectedName();
    if (!name) return null;
    return this.working().find(c => c.name === name) ?? null;
  });

  /**
   * Live preview of the YAML that will be written to
   * ``raccoon.project.yml`` under ``run_configurations:`` for the
   * selected entry. Builtins show "(builtin — nothing is persisted)"
   * because the CLI ships them in code; only user overrides hit disk.
   *
   * This matches the user's mental model: edits land in the project
   * file, and ``raccoon run <name>`` reads from there.
   */
  readonly yamlPreview = computed<string>(() => {
    const cfg = this.selected();
    if (!cfg) return '';
    if (cfg.builtin) {
      return `# '${cfg.name}' is a builtin preset shipped with raccoon-cli.\n# Nothing is written to raccoon.project.yml for unchanged builtins.\n# Edit any field to create a user override that lands here.`;
    }
    return this.renderYamlEntry(cfg);
  });

  /** Whether the dialog has any tombstones queued for save. */
  readonly hasTombstones = computed<boolean>(() => {
    const workingNames = new Set(this.working().map(c => c.name));
    return this.runAction.runConfigurations()
      .some(c => c.builtin && !workingNames.has(c.name));
  });

  /** Names of builtins the user has tombstoned in this session. */
  readonly tombstonedBuiltins = computed<string[]>(() => {
    const workingNames = new Set(this.working().map(c => c.name));
    return this.runAction.runConfigurations()
      .filter(c => c.builtin && !workingNames.has(c.name))
      .map(c => c.name);
  });

  // Env vars edited as KEY=VALUE per line — easiest UX and matches the CLI.
  envText = '';
  argsText = '';

  constructor(
    private http: HttpService,
    readonly runAction: RunActionService,
  ) {}

  show(): void {
    this.error.set(null);
    // Snapshot the live configs so the dialog stays independent until Save.
    const snapshot = this.runAction.runConfigurations().map(c => ({
      ...c,
      args: [...c.args],
      env: { ...c.env },
    }));
    this.working.set(snapshot);
    const current = this.runAction.selectedRunConfigName();
    const initial = current && snapshot.some(c => c.name === current)
      ? current
      : (snapshot[0]?.name ?? null);
    this.select(initial);
    this.visible.set(true);
  }

  close(): void {
    this.visible.set(false);
  }

  onVisibleChange(v: boolean): void {
    this.visible.set(v);
  }

  select(name: string | null): void {
    // Flush previous selection's textareas before switching panes.
    this.flushTextAreas();
    this.selectedName.set(name);
    const cfg = this.selected();
    this.envText = cfg
      ? Object.entries(cfg.env).map(([k, v]) => `${k}=${v}`).join('\n')
      : '';
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
    const copy: RunConfiguration = {
      ...cfg,
      args: [...cfg.args],
      env: { ...cfg.env },
      name: newName,
      builtin: false,
    };
    this.working.update(list => [...list, copy]);
    this.select(newName);
  }

  removeSelected(): void {
    const cfg = this.selected();
    if (!cfg) return;
    // Builtins are removable too — the backend tombstones them in
    // hidden_run_configurations: so neither the CLI nor the IDE sees
    // them after save. Re-adding an entry with the same name brings
    // them back.
    this.working.update(list => list.filter(c => c.name !== cfg.name));
    this.select(this.working()[0]?.name ?? null);
  }

  /**
   * Render a configuration as the YAML snippet that will end up under
   * ``run_configurations:`` in ``raccoon.project.yml``. The output
   * matches the format the CLI loader expects so the user can copy/
   * paste between projects if they want.
   */
  private renderYamlEntry(cfg: RunConfiguration): string {
    const lines: string[] = [`${cfg.name}:`];
    const indent = '  ';
    if (cfg.description) lines.push(`${indent}description: ${this.yamlString(cfg.description)}`);
    if (cfg.target && cfg.target !== 'auto') lines.push(`${indent}target: ${cfg.target}`);
    if (cfg.dev) lines.push(`${indent}dev: true`);
    if (cfg.no_calibrate) lines.push(`${indent}no_calibrate: true`);
    if (cfg.no_checkpoints) lines.push(`${indent}no_checkpoints: true`);
    if (cfg.no_codegen) lines.push(`${indent}no_codegen: true`);
    if (cfg.no_sync) lines.push(`${indent}no_sync: true`);
    if (cfg.record_localization) lines.push(`${indent}record_localization: true`);
    if (cfg.record_hz != null) lines.push(`${indent}record_hz: ${cfg.record_hz}`);
    // Flush textareas into args/env for the preview, since those are
    // edited live as strings and only sync back on save.
    const args = this.argsText.split(/\s+/).map(s => s.trim()).filter(Boolean);
    if (args.length) {
      lines.push(`${indent}args:`);
      for (const a of args) lines.push(`${indent}  - ${this.yamlString(a)}`);
    }
    const env = this.parseEnvTextFor(cfg);
    const keys = Object.keys(env);
    if (keys.length) {
      lines.push(`${indent}env:`);
      for (const k of keys) lines.push(`${indent}  ${k}: ${this.yamlString(env[k])}`);
    }
    if (lines.length === 1) lines.push(`${indent}{}`);
    return lines.join('\n');
  }

  private yamlString(s: string): string {
    // Quote anything that could trip the YAML parser; bare strings work
    // for the simple identifier-like cases.
    if (/^[A-Za-z0-9_\-./]+$/.test(s)) return s;
    return JSON.stringify(s);
  }

  /** Parse the env textarea but only when the *displayed* config matches. */
  private parseEnvTextFor(cfg: RunConfiguration): Record<string, string> {
    if (this.selected() !== cfg) return cfg.env;
    return this.parseEnvText();
  }

  /**
   * Patch the selected configuration in the working copy. Editing a
   * builtin clears its ``builtin`` flag so Save persists it as a
   * user-defined override of the preset.
   */
  patch<K extends keyof RunConfiguration>(key: K, value: RunConfiguration[K]): void {
    const cfg = this.selected();
    if (!cfg) return;
    this.working.update(list => list.map(c => c === cfg ? { ...c, builtin: false, [key]: value } : c));
  }

  onNameChange(newName: string): void {
    const cfg = this.selected();
    if (!cfg) return;
    const trimmed = newName.trim();
    if (!trimmed || trimmed === cfg.name) return;
    const taken = this.working().some(c => c !== cfg && c.name === trimmed);
    if (taken) {
      this.error.set(`A configuration named '${trimmed}' already exists`);
      return;
    }
    this.error.set(null);
    this.working.update(list => list.map(c => c === cfg ? { ...c, builtin: false, name: trimmed } : c));
    this.selectedName.set(trimmed);
  }

  /**
   * Reset a builtin override back to the shipped defaults by removing
   * the user copy. The backend re-surfaces the original builtin on
   * reload.
   */
  resetSelectedToBuiltin(): void {
    const cfg = this.selected();
    if (!cfg) return;
    const original = this.runAction.runConfigurations().find(c => c.name === cfg.name);
    if (!original?.builtin) return;
    const restored = { ...original, args: [...original.args], env: { ...original.env } };
    this.working.update(list => list.map(c => c === cfg ? restored : c));
    this.select(cfg.name);
  }

  isOverridingBuiltin(): boolean {
    const cfg = this.selected();
    if (!cfg) return false;
    const original = this.runAction.runConfigurations().find(c => c.name === cfg.name);
    return !!original?.builtin && !cfg.builtin;
  }

  /** Parse the env textarea — keeps the model clean of malformed entries. */
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

  /** Sync the textarea editors back into the selected config's model. */
  private flushTextAreas(): void {
    const cfg = this.selected();
    if (!cfg) return;
    const env = this.parseEnvText();
    const args = this.parseArgs();
    this.working.update(list => list.map(c => c === cfg
      ? { ...c, env, args, builtin: false }
      : c));
  }

  async save(): Promise<void> {
    const projectUuid = this.runAction.currentProjectUUID();
    if (!projectUuid) {
      this.error.set('No active project');
      return;
    }
    this.flushTextAreas();
    this.busy.set(true);
    this.error.set(null);
    try {
      // Server is the source of truth: PUT each user entry, then DELETE
      // anything that was removed. Builtins go through DELETE too so
      // the backend can tombstone them in hidden_run_configurations:.
      const original = this.runAction.runConfigurations();
      const current = this.working();
      const currentNames = new Set(current.map(c => c.name));
      for (const removed of original) {
        if (!currentNames.has(removed.name)) {
          await this.http.deleteRunConfiguration(projectUuid, removed.name).toPromise();
        }
      }
      for (const c of current) {
        if (c.builtin) continue;  // unchanged builtins live in code
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
