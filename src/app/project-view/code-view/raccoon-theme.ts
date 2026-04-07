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

/* ── Surface tokens (from --rc-* CSS vars) ──────────────── */
const bg         = '#2A2421';   // --rc-bg
const shell      = '#1E1A17';   // --rc-shell
const surface    = '#3A322C';   // --rc-surface
const elevated   = '#4A4038';   // --rc-elevated
const border     = '#4A4038';   // --rc-border
const text       = '#F5EBDC';   // --rc-text
const muted      = '#C8B9A5';   // --rc-muted
const dim        = '#8A7A6A';   // --rc-dim
const accent     = '#DAA03E';   // --rc-accent
const accentDim  = 'rgba(218, 160, 62, 0.12)';

/* ── Syntax palette ─────────────────────────────────────── */
const keyword    = '#DAA03E';   // amber  — keywords pop in brand colour
const fn         = '#78A0BE';   // blue   — function calls
const str        = '#6A994E';   // green  — strings
const number     = '#D4874E';   // warm orange — numbers, constants
const className  = '#E2C07B';   // soft gold — types, classes
const operator   = '#B8A080';   // warm tan — operators
const comment    = '#6E6050';   // warm stone — comments
const property   = '#C87860';   // clay — property names
const self       = '#945A78';   // berry — self, decorators
const cursor     = '#DAA03E';   // amber cursor
const selection  = 'rgba(218, 160, 62, 0.18)';
const activeLine = 'rgba(218, 160, 62, 0.06)';

/* ── Editor chrome theme ────────────────────────────────── */
const raccoonEditorTheme = EditorView.theme({
  '&': {
    color: text,
    backgroundColor: bg,
  },
  '.cm-content': {
    caretColor: cursor,
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: cursor,
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
    color: keyword, fontWeight: '600' },
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
    color: className },
  { tag: [tags.number],
    color: number },
  { tag: [tags.self],
    color: self },
  { tag: [tags.operator, tags.operatorKeyword],
    color: operator },
  { tag: [tags.url, tags.escape, tags.regexp, tags.link, tags.special(tags.string)],
    color: accent },
  { tag: [tags.string, tags.inserted],
    color: str },
  { tag: [tags.meta, tags.comment],
    color: comment, fontStyle: 'italic' },
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
    color: '#BA643C' },
]);

/** Complete Raccoon theme — drop-in replacement for oneDark. */
export const raccoonTheme: Extension = [
  raccoonEditorTheme,
  syntaxHighlighting(raccoonHighlightStyle),
];
