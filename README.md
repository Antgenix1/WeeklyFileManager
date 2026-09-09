# Weekly File Manager

An Obsidian plugin for rolling a weekly todo note over into the next week,
carrying forward any section that still has unfinished todos.

## Expected vault structure

The root folder name and the folder layout underneath it are both
configurable in settings (see below). By default it looks like:

```
ACEO/
  2025/
    01_January/
      2025-01-06 - 2025-01-11.md
    02_February/
      2025-02-02 - 2025-02-07.md
  2026/
    01_January/
      2026-01-05 - 2026-01-10.md
```

But the subfolder layout is just a template, so e.g. a flat `ACEO/2026-02-02
- 2026-02-07.md` structure, or `ACEO/2026/2026-02-02 - 2026-02-07.md` (year
only, no month), work too — see **Settings**.

Each weekly note is split into `---`-separated sections, each holding one or
more todos:

```markdown
- [ ] Todo1
---
- [ ] Todo2
   - [x] Todo2.1
---
- Todo3
```

## What it does

Running the command (or clicking the ribbon icon) on an open weekly note:

1. Parses the two dates in the file name (`YYYY-MM-DD - YYYY-MM-DD`).
2. Computes next week's date range by shifting both dates forward 7 days,
   so the same day-of-week pattern (e.g. Mon–Sat) is preserved.
3. Renders the subfolder template against the new **start** date (so a week
   that starts in September and ends in October still files under
   September), creating any missing folders under the root.
4. Copies over every section that still has an unfinished todo — an open
   checkbox `- [ ]` at any indentation, or a plain bullet with no checkbox
   (since those have no "done" state to check). Fully checked-off sections
   are dropped.
5. Creates the new file and opens it. If it already exists, it's opened
   instead of being overwritten.

### Graph view

Obsidian's graph view only connects notes that link to each other — it has
no notion of folder structure. So that weekly notes show up connected to
their month, and months to their year, the plugin creates a small index
note per subfolder (e.g. `ACEO/2026/09_September/09_September.md`,
`ACEO/2026/2026.md`) and links each new weekly note to its month's index
note, and each month's index note to its year's index note. These index
notes are only created once per folder (existing ones are left alone) and
the root folder itself never gets one. Turn this off with the **"Link
notes for the graph view"** setting if you don't want the extra notes.

## Usage

- Command palette: **"Roll over to next week"**.
- Or click the calendar ribbon icon while the current week's note is open.

Both only work while a note whose filename matches `YYYY-MM-DD - YYYY-MM-DD`
is active.

## Settings

- **Root folder** — the vault folder everything lives under. No default;
  must be set before rolling over a file. Start typing in the field to
  search and pick from your existing vault folders.
- **Subfolder layout** — a template for how new weekly notes are nested
  under the root folder, using `{{year}}`, `{{month}}` (September),
  `{{month_num}}` (09), and `{{month_folder}}` (09_September) as
  placeholders separated by `/`. Rendered against the new week's start
  date. Defaults to `{{year}}/{{month_folder}}`. Some examples:
  - `{{year}}/{{month_folder}}` → `ACEO/2026/02_February/2026-02-02 - 2026-02-07.md`
  - `{{year}}/{{month}}` → `ACEO/2026/February/2026-02-02 - 2026-02-07.md`
  - `{{year}}` → `ACEO/2026/2026-02-02 - 2026-02-07.md`
  - empty → `ACEO/2026-02-02 - 2026-02-07.md` (no subfolders)
- **Section separator** — the line used to split todo sections (default
  `---`).
- **Link notes for the graph view** — whether to create and link the
  year/month index notes described above (default on).

## Installing in Obsidian

### From source

1. `npm install`
2. `npm run build` (or `npm run dev` while iterating)
3. Copy `manifest.json`, `main.js`, and `styles.css` (if present) into
   `<your vault>/.obsidian/plugins/weekly-file-manager/`
4. Reload Obsidian and enable **Weekly File Manager** under
   Settings → Community plugins.

## Roadmap

Carried-over sections could later be sent through an n8n webhook (or any
other AI workflow) to restructure/clean up the todos before being written
into the new file. The rollover logic is written so that step can be
inserted between "collect unfinished sections" and "write the new file"
without touching the parsing/date logic.
