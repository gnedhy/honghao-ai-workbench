# dashi-taskboard code reuse

Source: https://github.com/chuspeeism/dashi-taskboard

Revision: `6a79ef522238ff11681cb85a9d803d19442a3d00` (inspected 2026-10-07).

Licensed under Apache-2.0; the original license is included in this directory.

Adapted files:

- `web/src/taskFilters.ts` → `src/tasks/taskFilters.ts`: retain text and status matching, use our task fields, remove unsupported issue priority/labels/link filters.
- `web/src/components/BoardColumn.tsx` and `TaskCard.tsx` → `src/tasks/BoardColumn.tsx`: retain status columns, card structure, empty states and conversation entry; use our AI task states and existing callbacks, remove manual issue changes and host integration.
- Board column/card layout in `web/src/styles.css` → scoped `.task-panel` styles in `src/styles.css`: use existing workbench colors, sizes and responsive rules.

No launcher, Codex injection, external task database, or external service is installed. The existing API ownership and execution boundaries are preserved.
