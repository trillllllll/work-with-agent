import { defaultEditBudgets, editBudgets } from './edit-budget.js';

/** The shipped soft budget; the effective value comes from editBudgets(). */
export const textEditBudgetBytes = defaultEditBudgets.text;
export const textReadingPageSize = 10_000;

export function withinTextEditBudget(value: string, limit = editBudgets().text) {
  // Every UTF-16 unit costs at least one UTF-8 byte, so bound the allocation first.
  return value.length <= limit && new TextEncoder().encode(value).byteLength <= limit;
}

/** UTF-16 boundaries without splitting surrogate pairs or allocating a copy of all characters. */
export function textPageOffsets(value: string, size = textReadingPageSize) {
  const offsets = [0];
  let offset = 0;
  while (offset < value.length) {
    let next = Math.min(value.length, offset + Math.max(2, size));
    if (next < value.length && value.charCodeAt(next - 1) >= 0xd800 && value.charCodeAt(next - 1) <= 0xdbff && value.charCodeAt(next) >= 0xdc00 && value.charCodeAt(next) <= 0xdfff) next--;
    offsets.push(next); offset = next;
  }
  return offsets;
}
