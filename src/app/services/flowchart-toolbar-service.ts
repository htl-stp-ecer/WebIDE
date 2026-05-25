import { Injectable, signal } from '@angular/core';

/**
 * Bridges the project-scoped flowchart toolbar buttons (settings, undo/redo,
 * timestamp toggle) to the global navbar.
 *
 * The flowchart registers handlers + reactive state on init; the navbar
 * renders the buttons when `available()` is true.
 */
@Injectable({ providedIn: 'root' })
export class FlowchartToolbarService {
  readonly available = signal(false);
  readonly canUndo = signal(false);
  readonly canRedo = signal(false);
  readonly timestampsEnabled = signal(false);

  private handlers: {
    undo?: () => void;
    redo?: () => void;
    toggleTimestamps?: () => void;
    openSettings?: () => void;
  } = {};

  register(handlers: {
    undo: () => void;
    redo: () => void;
    toggleTimestamps: () => void;
    openSettings: () => void;
  }): void {
    this.handlers = handlers;
    this.available.set(true);
  }

  unregister(): void {
    this.handlers = {};
    this.available.set(false);
    this.canUndo.set(false);
    this.canRedo.set(false);
    this.timestampsEnabled.set(false);
  }

  undo(): void { this.handlers.undo?.(); }
  redo(): void { this.handlers.redo?.(); }
  toggleTimestamps(): void { this.handlers.toggleTimestamps?.(); }
  openSettings(): void { this.handlers.openSettings?.(); }
}
