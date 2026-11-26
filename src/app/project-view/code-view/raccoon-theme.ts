/**
 * Custom CodeMirror 6 theme using the RaccoonOS design system palette.
 *
 * Surfaces use the warm brown/taupe tokens; syntax colours are chosen
 * to complement the amber accent while staying readable on dark backgrounds.
 */
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { Extension } from '@codemirror/state';

const bg = 'var(--rc-canvas)';
const shell = 'var(--rc-shell)';
const surface = 'var(--rc-surface)';
const elevated = 'var(--rc-elevated)';
const border = 'var(--rc-border)';
const text = 'var(--rc-text)';
const muted = 'var(--rc-muted)';
const dim = 'var(--rc-dim)';
const accent = 'var(--rc-accent)';
const selection = 'var(--rc-accent-glow)';
const activeLine = 'var(--rc-accent-dim)';

const fn = 'var(--rc-sand)';
const str = 'var(--rc-green)';
const number = 'var(--rc-orange)';
const property = '#e9b9a6';
const self = 'var(--rc-berry)';

/* ── Editor chrome theme ────────────────────────────────── */
const raccoonEditorTheme = EditorView.theme({
  '&': {
    color: text,
    backgroundColor: bg,
  },
  '.cm-content': {
    caretColor: accent,
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: accent,
  },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: selection,
  },
  '.cm-panels': {
    backgroundColor: shell,
    color: text,
  },
  '.cm-panels.cm-panels-top': {
    borderBottom: `1px solid ${border}`,
  },
  '.cm-panels.cm-panels-bottom': {
    borderTop: `1px solid ${border}`,
  },
  '.cm-searchMatch': {
    backgroundColor: 'rgba(218, 160, 62, 0.25)',
    outline: `1px solid ${accent}`,
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'rgba(218, 160, 62, 0.40)',
  },
  '.cm-activeLine': {
    backgroundColor: activeLine,
  },
  '.cm-selectionMatch': {
    backgroundColor: 'rgba(218, 160, 62, 0.12)',
  },
  '&.cm-focused .cm-matchingBracket': {
    backgroundColor: 'rgba(218, 160, 62, 0.30)',
    outline: `1px solid ${accent}`,
  },
  '&.cm-focused .cm-nonmatchingBracket': {
    backgroundColor: 'rgba(186, 100, 60, 0.30)',
  },
  '.cm-gutters': {
    backgroundColor: shell,
    color: dim,
    border: 'none',
    borderRight: `1px solid ${border}`,
  },
  '.cm-activeLineGutter': {
    backgroundColor: surface,
    color: muted,
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'transparent',
    border: 'none',
    color: dim,
  },
  '.cm-tooltip': {
    border: `1px solid ${border}`,
    backgroundColor: surface,
    color: text,
  },
  '.cm-tooltip .cm-tooltip-arrow:before': {
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
  },
  '.cm-tooltip .cm-tooltip-arrow:after': {
    borderTopColor: surface,
    borderBottomColor: surface,
  },
  '.cm-tooltip-autocomplete': {
    '& > ul > li[aria-selected]': {
      backgroundColor: elevated,
      color: text,
    },
  },
  '.cm-lint-marker': {
    width: '0.6em',
  },
}, { dark: true });

/* ── Syntax highlighting ────────────────────────────────── */
const raccoonHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword,
    color: accent, fontWeight: '600' },
  { tag: [tags.name, tags.deleted, tags.character, tags.macroName],
    color: text },
  { tag: [tags.propertyName],
    color: property },
  { tag: [tags.function(tags.variableName), tags.labelName],
    color: fn },
  { tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)],
    color: number },
  { tag: [tags.definition(tags.name), tags.separator],
    color: text },
  { tag: [tags.typeName, tags.className, tags.changed, tags.annotation, tags.modifier, tags.namespace],
    color: fn },
  { tag: [tags.number],
    color: number },
  { tag: [tags.self],
    color: self },
  { tag: [tags.operator, tags.operatorKeyword],
    color: muted },
  { tag: [tags.url, tags.escape, tags.regexp, tags.link, tags.special(tags.string)],
    color: accent },
  { tag: [tags.string, tags.inserted],
    color: str },
  { tag: [tags.meta, tags.comment],
    color: dim, fontStyle: 'italic' },
  { tag: tags.strong,
    fontWeight: 'bold' },
  { tag: tags.emphasis,
    fontStyle: 'italic' },
  { tag: tags.strikethrough,
    textDecoration: 'line-through' },
  { tag: tags.link,
    color: fn, textDecoration: 'underline' },
  { tag: tags.heading,
    fontWeight: 'bold', color: accent },
  { tag: [tags.atom, tags.bool],
    color: number },
  { tag: tags.invalid,
    color: 'var(--rc-red)' },
]);

/** Complete Raccoon theme — drop-in replacement for oneDark. */
export const raccoonTheme: Extension = [
  raccoonEditorTheme,
  syntaxHighlighting(raccoonHighlightStyle),
];
