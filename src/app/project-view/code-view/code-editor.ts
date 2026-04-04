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
  highlightActiveLine,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { python } from '@codemirror/lang-python';
import { oneDark } from '@codemirror/theme-one-dark';

@Component({
  selector: 'app-code-editor',
  standalone: true,
  template: '<div #host class="cm-host"></div>',
  styles: [`
    :host { display: block; height: 100%; overflow: hidden; }
    .cm-host { height: 100%; }
    :host ::ng-deep .cm-editor { height: 100%; font-size: 13px; }
    :host ::ng-deep .cm-scroller { overflow: auto; font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace; }
  `],
})
export class CodeEditorComponent implements AfterViewInit, OnChanges, OnDestroy {
  @ViewChild('host') hostRef!: ElementRef<HTMLDivElement>;

  @Input() content = '';
  @Input() dark = false;
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
    if ((changes['dark'] || changes['readonly']) && this.view) {
      this.rebuild();
    }
  }

  ngOnDestroy(): void {
    this.view?.destroy();
  }

  private buildEditor(): void {
    if (!this.hostRef?.nativeElement) return;

    const extensions: Extension[] = [
      lineNumbers(),
      history(),
      highlightActiveLine(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      python(),
      EditorView.theme({
        '&': { height: '100%' },
        '.cm-scroller': { overflow: 'auto' },
      }),
      EditorView.updateListener.of(update => {
        if (update.docChanged && !this.externalUpdate) {
          this.contentChange.emit(update.state.doc.toString());
        }
        this.externalUpdate = false;
      }),
      EditorState.readOnly.of(this.readonly),
    ];

    if (this.dark) {
      extensions.push(oneDark);
    }

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
