# Changelog

## 1.0.1 — 2026-11-22

- Add this changelog and ship it in the published package.

## 1.0.0 — 2026-11-22

- First release.
- Session context menu item "Delete session…" (own trash icon, danger styling, placed before Archive).
- Confirmation dialog built from the DSH primitives `Modal` and `Button`, so it follows the app appearance settings.
- Host route `POST /api/dsh-session-delete/delete`, guarded by:
  - session id format check,
  - `workspace/session-activity` waterfall (running agents, jobs, subagents, schedule),
  - on-disk layout check (file name, session directory name, `--<cwd>--` parent),
  - retrying `fs.rm` with a `session/locked` error when another program holds the files.
- Removes the session directory, then clears the archived/pinned ids so no ghost entries remain.
- Refuses to delete the session currently open in the main view.
- Offline host test (`node test-host.mjs`) covering 200, 400 and 409 paths.
