# RaccoonOS Web IDE — Design Guidelines

The Web IDE follows the **RaccoonOS brand identity**: warm, earthy, raccoon-themed.
Single dark theme. No light/dark toggle.

---

## Color Palette

Defined as CSS custom properties in `src/styles.css` and Tailwind `@theme` tokens.
Use `var(--rc-*)` in SCSS files and `bg-rc-*` / `text-rc-*` / `border-rc-*` in templates.

### Backgrounds (darkest → lightest)

| Token | Value | Usage |
|---|---|---|
| `--rc-shell` | `#1E1A17` | Navbar, toolbar chrome, deepest surfaces |
| `--rc-bg` | `#2A2421` | Main page background |
| `--rc-surface` | `#3A322C` | Cards, panels, sidebars |
| `--rc-elevated` | `#4A4038` | Hover states, dropdowns, elevated elements |

### Text

| Token | Value | Usage |
|---|---|---|
| `--rc-text` | `#F5EBDC` | Primary text (cream) |
| `--rc-muted` | `#C8B9A5` | Secondary text, labels |
| `--rc-dim` | `#8A7A6A` | Placeholders, disabled, very subtle |

### Accent Colors

| Token | Value | Usage |
|---|---|---|
| `--rc-accent` | `#DAA03E` | **Amber — primary accent.** Focus rings, active states, selected nodes, primary buttons, logo |
| `--rc-green` | `#6A994E` | Online status, success, run button |
| `--rc-red` | `#BA643C` | Rust — errors, stop button, offline status |
| `--rc-blue` | `#78A0BE` | Sky — informational |
| `--rc-berry` | `#945A78` | Secondary accent (decorative use only) |

### Borders

| Context | Value |
|---|---|
| Structural dividers (panels, nav) | `var(--rc-border)` = `#4A4038` |
| Amber card hover border | `rgba(218, 160, 62, 0.4)` |
| Dashed amber borders (add-item, groups) | `rgba(218, 160, 62, 0.22)` |
| Subtle amber glow | `rgba(218, 160, 62, 0.12)` |

---

## Typography

### Fonts

Both loaded via Google Fonts in `src/index.html`.

| Font | Weight | Usage |
|---|---|---|
| **Space Grotesk** | 400, 500, 600, 700 | All UI text — headings, labels, buttons, body |
| **JetBrains Mono** | 400, 500, 700 | Code, IP addresses, UUIDs, technical values, battery readouts |

### Scale

| Use | Size | Weight |
|---|---|---|
| Page heading | `1rem–1.125rem` | 700 |
| Section label (uppercase) | `0.65rem`, `letter-spacing: 0.1em` | 700 |
| Body / card text | `0.8125rem–0.875rem` | 400–500 |
| Small / hint | `0.75rem` | 400 |
| Mono detail (UUID, IP) | `0.7rem` | 400–600 |

---

## Signature Design Elements

### Navbar — Amber Bottom Border
The navbar's most distinctive feature. Mirrors the docs site header exactly.

```scss
.navbar-root {
  background: var(--rc-shell); // #1E1A17
  border-bottom: 2px solid var(--rc-accent); // amber
}
```

### Focus / Selection Glow
All interactive elements use amber focus rings, never blue.

```scss
// Input focus
border-color: var(--rc-accent);
box-shadow: 0 0 0 3px rgba(218, 160, 62, 0.12);

// Node selection (flowchart)
box-shadow:
  inset 0 0 0 2px var(--rc-accent),
  0 0 0 3px rgba(218, 160, 62, 0.14);
```

### Primary Buttons
Amber background with warm-dark text. Never white text on amber.

```scss
background: var(--rc-accent);     // #DAA03E
color: var(--rc-shell);           // #1E1A17
// hover:
background: #E8B54A;
box-shadow: 0 0 16px rgba(218, 160, 62, 0.4);
```

### Dashed Borders (add-item zones, flowchart groups)
```scss
border: 2px dashed rgba(218, 160, 62, 0.22);
background: rgba(218, 160, 62, 0.03);
// hover:
border-color: rgba(218, 160, 62, 0.4);
```

### Canvas Dot-Grid
The flowchart canvas has a warm dot-grid background.
```scss
background-image: radial-gradient(circle, rgba(218, 160, 62, 0.08) 1px, transparent 1px);
background-size: 24px 24px;
```

### Card Hover
Cards get an amber border tint on hover, never a background color change alone.
```scss
border-color: rgba(218, 160, 62, 0.4);
box-shadow: 0 0 0 1px rgba(218, 160, 62, 0.08), 0 8px 24px rgba(0, 0, 0, 0.4);
```

---

## Component Patterns

### Status Pills (online / offline / loading)
Inline pill with colored dot and uppercase label. Used in navbar device status.

```html
<span class="status-pill online">
  <span class="status-dot"></span>
  Online
</span>
```

| State | Color |
|---|---|
| online | `--rc-green` `#6A994E` |
| offline | `--rc-red` `#BA643C` |
| loading | `--rc-yellow` (= amber) with pulse animation |

### Toolbar Buttons (IDE)
32×32 rounded square, dark surface, muted icon. Active state uses amber.

```scss
// default
background: var(--rc-surface);
border: 1px solid var(--rc-border);
color: var(--rc-muted);
// active
background: rgba(218, 160, 62, 0.12);
border-color: rgba(218, 160, 62, 0.4);
color: var(--rc-accent);
```

### Run / Stop Buttons
```scss
.run  { background: var(--rc-green); color: #1E1A17; }
.stop { background: var(--rc-red);   color: #F5EBDC; }
```

### Panel Toggle Bar (Flow / Code)
Shell-dark background with amber active tab.

```scss
.center-toggle-bar {
  background: var(--rc-shell);
  border-bottom: 1px solid var(--rc-border);
}
.center-toggle-btn.active {
  color: var(--rc-accent);
  border-color: rgba(218, 160, 62, 0.3);
}
```

### Flowchart Nodes
Dark surface with warm border. Amber glow when selected.
```scss
.node {
  background: var(--rc-surface);     // #3A322C
  box-shadow: inset 0 0 0 1px var(--rc-border), 0 4px 12px rgba(0,0,0,0.35);
  --node-field-bg: #2A2421;
  --node-field-border: #4A4038;
  --node-field-color: #F5EBDC;
}
.node.node-selected {
  box-shadow: inset 0 0 0 2px #DAA03E, 0 0 0 3px rgba(218,160,62,0.14);
}
```

---

## Dark Theme Architecture

The app uses a **single fixed dark theme** — no user toggle.

- `class="dark"` is hardcoded on `<html>` in `src/index.html`
- PrimeNG overrides use `.dark .p-*` selectors in `src/styles.css`
- All component SCSS uses `var(--rc-*)` variables directly (no `:host-context(.dark)` duplication)
- The dark mode toggle was removed from the navbar

---

## File Structure

```
src/
├── index.html                          ← Google Fonts, class="dark" on <html>
├── styles.css                          ← Design tokens (@theme + :root vars + PrimeNG overrides)
└── app/
    ├── navbar/navbar.scss              ← Amber bottom border, status pills
    ├── home/home.scss                  ← Connect hero, warm grid background
    ├── local-projects/local-projects.scss
    └── project-view/
        ├── project-view.scss           ← Panel layout, amber resizer hover
        ├── mission-panel/mission-panel.scss
        ├── step-panel/step-panel.scss
        ├── code-view/code-view.scss
        └── flowchart/styles/
            ├── base.scss               ← Canvas dot-grid, offscreen indicators
            ├── node.scss               ← Node surfaces + amber selection
            ├── toolbar.scss            ← Run/stop + toggle chip styles
            ├── group.scss              ← Dashed amber group borders
            ├── canvas.scss             ← Connection stroke colors
            ├── comment.scss            ← Comment node glass style
            └── floating.scss           ← Floating panel positioning
```

---

## Reference

- **Documentation site**: `/media/tobias/TobiasSSD/Botball/documentation/static/css/style.css`
- **Video kit**: `/home/tobias/Downloads/raccoonos-video-kit-v2(1)/raccoonos-video-kit-v2/README.md`
- The exact palette (`--bg-dark`, `--amber`, `--cream`, etc.) is defined in the docs CSS under `:root` and is the canonical brand reference.
