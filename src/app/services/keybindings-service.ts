import { Injectable, signal } from '@angular/core';
import { Step } from '../project-view/flowchart/models';

export interface StepKeybinding {
  stepName: string;
  stepImport: string | null;
  stepFile: string | undefined;
  keybind: string; // e.g., "ctrl+1", "alt+s"
}

export interface RecentStep {
  step: Step;
  usageCount: number;
  lastUsed: number;
}

interface KeybindingsStorage {
  stepKeybindings: StepKeybinding[];
  recentSteps: RecentStep[];
}

const STORAGE_KEY = 'webide-keybindings';
const MAX_RECENT_STEPS = 10;

@Injectable({ providedIn: 'root' })
export class KeybindingsService {
  readonly stepKeybindings = signal<StepKeybinding[]>([]);
  readonly recentSteps = signal<RecentStep[]>([]);

  constructor() {
    this.loadFromStorage();
  }

  private loadFromStorage(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed: KeybindingsStorage = JSON.parse(raw);
      if (parsed.stepKeybindings && Array.isArray(parsed.stepKeybindings)) {
        this.stepKeybindings.set(parsed.stepKeybindings);
      }
      if (parsed.recentSteps && Array.isArray(parsed.recentSteps)) {
        this.recentSteps.set(parsed.recentSteps);
      }
    } catch {
      // Ignore storage failures
    }
  }

  private saveToStorage(): void {
    try {
      const data: KeybindingsStorage = {
        stepKeybindings: this.stepKeybindings(),
        recentSteps: this.recentSteps(),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // Ignore storage failures
    }
  }

  trackStepUsage(step: Step): void {
    const current = this.recentSteps();
    const existing = current.find(
      r => r.step.name === step.name &&
           r.step.import === step.import &&
           r.step.file === step.file
    );

    let updated: RecentStep[];
    if (existing) {
      updated = current.map(r =>
        r === existing
          ? { ...r, usageCount: r.usageCount + 1, lastUsed: Date.now() }
          : r
      );
    } else {
      updated = [
        { step, usageCount: 1, lastUsed: Date.now() },
        ...current,
      ];
    }

    // Sort by usage count (descending), then by last used (descending)
    updated.sort((a, b) => {
      if (b.usageCount !== a.usageCount) return b.usageCount - a.usageCount;
      return b.lastUsed - a.lastUsed;
    });

    // Keep only top N
    updated = updated.slice(0, MAX_RECENT_STEPS);

    this.recentSteps.set(updated);
    this.saveToStorage();
  }

  setStepKeybinding(step: Step, keybind: string): void {
    const current = this.stepKeybindings();

    // Remove any existing keybinding for this step
    const filtered = current.filter(
      k => !(k.stepName === step.name &&
             k.stepImport === (step.import ?? null) &&
             k.stepFile === step.file)
    );

    // Remove any existing keybinding using this key combo
    const withoutConflict = filtered.filter(k => k.keybind !== keybind);

    if (keybind) {
      withoutConflict.push({
        stepName: step.name,
        stepImport: step.import ?? null,
        stepFile: step.file,
        keybind,
      });
    }

    this.stepKeybindings.set(withoutConflict);
    this.saveToStorage();
  }

  removeStepKeybinding(step: Step): void {
    const current = this.stepKeybindings();
    const filtered = current.filter(
      k => !(k.stepName === step.name &&
             k.stepImport === (step.import ?? null) &&
             k.stepFile === step.file)
    );
    this.stepKeybindings.set(filtered);
    this.saveToStorage();
  }

  getKeybindingForStep(step: Step): string | null {
    const bindings = this.stepKeybindings();
    const found = bindings.find(
      k => k.stepName === step.name &&
           k.stepImport === (step.import ?? null) &&
           k.stepFile === step.file
    );
    return found?.keybind ?? null;
  }

  getStepForKeybinding(keybind: string): StepKeybinding | null {
    const bindings = this.stepKeybindings();
    return bindings.find(k => k.keybind === keybind) ?? null;
  }

  parseKeyEvent(event: KeyboardEvent): string {
    const parts: string[] = [];
    if (event.ctrlKey || event.metaKey) parts.push('ctrl');
    if (event.altKey) parts.push('alt');
    if (event.shiftKey) parts.push('shift');

    const key = event.key.toLowerCase();
    // Don't include modifier keys themselves
    if (!['control', 'alt', 'shift', 'meta'].includes(key)) {
      parts.push(key);
    }

    return parts.join('+');
  }

  formatKeybinding(keybind: string): string {
    return keybind
      .split('+')
      .map(part => {
        switch (part) {
          case 'ctrl': return 'Ctrl';
          case 'alt': return 'Alt';
          case 'shift': return 'Shift';
          default: return part.toUpperCase();
        }
      })
      .join(' + ');
  }

  clearAllKeybindings(): void {
    this.stepKeybindings.set([]);
    this.saveToStorage();
  }

  clearRecentSteps(): void {
    this.recentSteps.set([]);
    this.saveToStorage();
  }
}
