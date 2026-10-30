/**
 * Interactive editing budgets. Within the soft budget a document opens straight into the editor.
 * Beyond it the document opens as paginated reading with an explicit "edit anyway"; beyond the hard
 * budget only reading and download are offered. A document that is already open for editing is never
 * switched to read-only because it grew. No module here depends on React or the bundler, so browser
 * tests can import the same numbers.
 */
export type RichBudget = { blocks: number; bytes: number };
export type EditBudgets = { rich: RichBudget; richHard: RichBudget; text: number; textHard: number };

export const defaultEditBudgets: EditBudgets = {
  rich: { blocks: 500, bytes: 256 * 1024 },
  richHard: { blocks: 2_000, bytes: 1024 * 1024 },
  text: 256 * 1024,
  textHard: 1024 * 1024,
};
/** Development-only measurement override, JSON shaped like Partial<EditBudgets>. */
export const editBudgetOverrideKey = 'dovun.documents.editBudget';

let active: EditBudgets = defaultEditBudgets;
export function editBudgets() { return active; }

/** Used by development builds and tests to measure documents above the shipped budgets. */
export function overrideEditBudgets(value: Partial<EditBudgets> | null) {
  active = value ? {
    rich: { ...defaultEditBudgets.rich, ...value.rich }, richHard: { ...defaultEditBudgets.richHard, ...value.richHard },
    text: value.text ?? defaultEditBudgets.text, textHard: value.textHard ?? defaultEditBudgets.textHard,
  } : defaultEditBudgets;
}

/** "256 KiB", "1 MiB": budget sizes shown to the user. */
export function formatBudgetBytes(bytes: number) {
  return bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)} MiB` : `${Math.round(bytes / 1024)} KiB`;
}
