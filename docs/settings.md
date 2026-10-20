# Settings page structure

Settings is split into six categories. Each one has its own address, and the page layout depends on screen width.

| Category | Hash | Sections, in order |
|---|---|---|
| Models & AI (`model`) | `#/settings/model` | Model settings, Brave image search, interactive pages (HTML blocks) |
| Local execution (`local`) | `#/settings/local` | Local AI commands (Codex / Claude Code), orchestration (executors, notifications, projects, list default projects), link to Worktree management |
| Skills (`skills`) | `#/settings/skills` | Skill counts, link to the skills page |
| Interface (`ui`) | `#/settings/ui` | Language, phone tab bar |
| Data (`data`) | `#/settings/data` | Backup and restore |
| About (`about`) | `#/settings/about` | Server mode and version |

## Adding a settings block

Change the registry only. Do not add JSX to `SettingsView`.

1. Add a section id to `SETTINGS_SECTIONS` in `client/src/components/settings/settings-categories.ts`, and add it to the `sections` of the right category.
2. Map that id to its component in `SETTINGS_SECTION_COMPONENTS` in `client/src/components/settings/settings-registry.tsx`. The component receives `{ onNavigate }` for links to other pages.
3. The component renders one `<section>` with an `h3` title. The view adds the spacing and divider between blocks, so the component has no outer margin or border.
4. Every string goes through `t()`, with entries in both `zh-CN` and `en`. `npm run i18n:check` enforces this.

`settings-categories.test.ts` checks that every section is placed exactly once. TypeScript checks that every id has a component.

To add a new category, add its id to `SETTINGS_CATEGORIES` and `SETTINGS_CATEGORY_DEFS`, give it an icon in `SETTINGS_CATEGORY_ICONS` and a status line in `useSettingsCategoryHints`, and add `layout.categories.<id>.title|lead` to both locales.

## Routing

- `parseHash` in `client/src/hooks/useHashRoute.ts` reads the second segment of `#/settings/<category>` into `settingsCategory`. `view` stays `settings`. Unknown categories count as `#/settings`, and anything after the category is ignored.
- `openSettings(category | null)` pushes the address, so the browser back button returns to the previous category or to the list.
- When the assistant is expanded to its own page, the category is saved in `assistantOrigin`, so the open category and any unsaved form input survive the expand and shrink.
- `#/trash` and `#/changes` keep working. The model setup links in the knowledge page and the chat panel open `#/settings/model`.

## Layout

- **Desktop (≥ 1024px)**: the modal size is unchanged. The header is one row: the Settings / Trash / Change history tabs, then the AI assistant button and close. Inside Settings, the left column lists the categories, each with a one-line status, and the right column shows only the current category. The two columns scroll separately. `#/settings` shows Models & AI without rewriting the address.
- **Phone (< 1024px, tablets included)**: the modal is full screen. `#/settings` shows the grouped category list, with Trash and Change history in their own group at the bottom. A category opens a detail page with a one-row "‹ Category" header, and its back button returns to `#/settings`. The AI assistant is a floating button in the lower right of the content area, and every page leaves bottom padding so the last control can scroll above it. Esc and clicking outside close the whole modal.
- Switching category discards unsaved input, the same as closing the modal.
- If `/api/settings` fails, only the model form and the local AI commands show the error and a retry button. The other blocks keep working.

## Phone tab bar rows

Each row is a drag handle, an icon, a name and a switch. The move up and move down buttons are gone. Ways to reorder:

- **Mouse**: drag the handle after moving 6px.
- **Touch**: long-press the handle for 200ms, then drag. Only the handle has `touch-action: none`, so the rest of the list still scrolls.
- **Keyboard**: focus the handle, press Space, use the arrow keys, then press Space again. Screen readers hear the localized instructions in `mobileNavigation.reorderHint`.
