# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Web IDE is an Angular 20 application for managing Botball robotics projects. It provides a visual flowchart mission editor, Python code editor, and remote device management, communicating with a local backend and robot devices over HTTP/WebSocket.

## Commands

```bash
npm start               # Dev server at http://localhost:4300
npm run build           # Production build → dist/WebIDE/ (base href: /WebIDE/)
npm test                # Unit tests with Karma/Jasmine
npm run test:logic      # Logic tests with Vitest (faster, includes coverage)
npm run test:logic:watch # Vitest in watch mode
npm run watch           # Build in watch mode (development config)
```

To run a single Vitest test file:
```bash
npx vitest run src/path/to/file.spec.ts
```

## Architecture

### Key Abstractions

**Two backends**: The app talks to both a *local backend* (configurable port, default 3000) and *device backends* (robot Pis at port 8421). `PortInterceptor` (`src/app/interceptors/PortInterceptor.ts`) normalizes all outgoing HTTP URLs to inject the correct scheme and port. `HttpService` (`src/app/services/http-service.ts`) is the single service for all API calls and WebSocket mission execution.

**State via signals**: `MissionStateService` and `StepsStateService` use Angular signals for reactive state — no NgRx or external state library.

### Routing

- `/` — Home: device IP connection, LocalStorage-persisted history, 5s polling for device status
- `/projects` — Local projects list with create/delete
- `/projects/:uuid` — Main project editor (3-panel IDE)
- `/device/:ip/projects` — Remote device project menu

### Project Editor (`project-view/`)

Three-panel layout with LocalStorage-persisted panel widths:
- **Left**: Mission panel (mission list, step groups)
- **Center**: Toggle between flowchart editor (`flowchart/`) and Python code editor (`code-view/`)
- **Right**: Step panel (available step types, properties)

The flowchart uses `@foblex/flow` for drag-drop node editing, supports undo/redo, context menus, and real-time WebSocket execution with simulation overlays.

The code view uses CodeMirror 6 with Python syntax highlighting.

### Data Model

`Project` → has `connection` (ip, port, remote_path) → contains `Mission[]` → each `Mission` has `steps: MissionStep[]`, `groups`, `comments`, and lifecycle flags (`is_setup`, `is_shutdown`).

### Styling

- Tailwind CSS 4 + PrimeNG 20 with a custom "Noir" preset (zinc palette, Aura base)
- Component styles in SCSS
- Dark mode via `.dark` class selector
- Production CSS budget: 6MB initial, 35kB per component

### App Configuration (`src/app/app.config.ts`)

Bootstrapped as standalone (no NgModules). Providers include: PrimeNG theme, `@ngx-translate` HTTP loader (English default), `PortInterceptor`, and `eventCoalescing` change detection.

### Testing Split

- Karma tests (`*.spec.ts`) for Angular components/services — run with `ng test`
- Vitest tests for pure logic — faster iteration, coverage enabled
