import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  ViewChild,
} from '@angular/core';
import { EditorState, Extension } from '@codemirror/state';
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  highlightTrailingWhitespace,
  keymap,
  lineNumbers,
  rectangularSelection,
  scrollPastEnd,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { python } from '@codemirror/lang-python';
import { raccoonTheme } from './raccoon-theme';
import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
} from '@codemirror/language';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { linter, lintGutter, lintKeymap, type Diagnostic } from '@codemirror/lint';

/** Basic Python structural linter — catches indentation issues client-side. */
function pythonLinter(view: EditorView): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const doc = view.state.doc;

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const text = line.text;

    // Skip empty lines and comments
    if (text.trim() === '' || text.trimStart().startsWith('#')) continue;

    const leadingSpaces = text.length - text.trimStart().length;
    const leadingWhitespace = text.slice(0, leadingSpaces);

    // Check for tab/space mixing
    if (leadingWhitespace.includes('\t') && leadingWhitespace.includes(' ')) {
      diagnostics.push({
        from: line.from,
        to: line.from + leadingSpaces,
        severity: 'error',
        message: 'Mixed tabs and spaces in indentation',
      });
    }
  }

  return diagnostics;
}

@Component({
  selector: 'app-code-editor',
  standalone: true,
  template: '<div #host class="cm-host"></div>',
  styles: [`
    :host { display: block; height: 100%; overflow: hidden; }
    .cm-host { height: 100%; }
    :host ::ng-deep .cm-editor { height: 100%; font-size: 13px; }
    :host ::ng-deep .cm-scroller { overflow: auto; font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace; }
    :host ::ng-deep .cm-tooltip-autocomplete { font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace; font-size: 12px; }
  `],
})
export class CodeEditorComponent implements AfterViewInit, OnChanges, OnDestroy {
  @ViewChild('host') hostRef!: ElementRef<HTMLDivElement>;

  @Input() content = '';
  @Input() readonly = false;

  @Output() contentChange = new EventEmitter<string>();

  private view: EditorView | null = null;
  private externalUpdate = false;

  ngAfterViewInit(): void {
    this.buildEditor();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['content'] && this.view) {
      const incoming = changes['content'].currentValue ?? '';
      const current = this.view.state.doc.toString();
      if (current !== incoming) {
        this.externalUpdate = true;
        this.view.dispatch({
          changes: { from: 0, to: this.view.state.doc.length, insert: incoming },
        });
      }
    }
    if (changes['readonly'] && this.view) {
      this.rebuild();
    }
  }

  ngOnDestroy(): void {
    this.view?.destroy();
  }

  private buildEditor(): void {
    if (!this.hostRef?.nativeElement) return;

    const extensions: Extension[] = [
      // Theme — Raccoon warm dark palette
      raccoonTheme,

      // Gutter
      lineNumbers(),
      highlightActiveLineGutter(),
      foldGutter(),
      lintGutter(),

      // Core editing
      history(),
      indentUnit.of('    '),
      EditorState.tabSize.of(4),
      indentOnInput(),
      closeBrackets(),
      bracketMatching(),
      autocompletion(),

      // Visual
      highlightActiveLine(),
      highlightSpecialChars(),
      highlightTrailingWhitespace(),
      highlightSelectionMatches(),
      drawSelection(),
      dropCursor(),
      scrollPastEnd(),
      rectangularSelection(),
      crosshairCursor(),

      // Language
      python(),

      // Linting
      linter(pythonLinter, { delay: 500 }),

      // Keymaps
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...searchKeymap,
        ...lintKeymap,
        indentWithTab,
      ]),

      // Layout
      EditorView.theme({
        '&': { height: '100%' },
        '.cm-scroller': { overflow: 'auto' },
      }),

      // Change listener
      EditorView.updateListener.of(update => {
        if (update.docChanged && !this.externalUpdate) {
          this.contentChange.emit(update.state.doc.toString());
        }
        this.externalUpdate = false;
      }),

      EditorState.readOnly.of(this.readonly),
    ];

    this.view = new EditorView({
      state: EditorState.create({ doc: this.content, extensions }),
      parent: this.hostRef.nativeElement,
    });
  }

  private rebuild(): void {
    const saved = this.view?.state.doc.toString() ?? this.content;
    this.view?.destroy();
    this.view = null;
    this.content = saved;
    this.buildEditor();
  }
}
