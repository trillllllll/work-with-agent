import type { Extensions } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import { StarterKit } from '@tiptap/starter-kit';
import { Link, type LinkOptions } from '@tiptap/extension-link';
import { ListKit } from '@tiptap/extension-list';

/** Shared editing primitives. Storage, resource identity and save rules belong to each adapter. */
export function createEditorCore(options: { horizontalRule?: boolean; isAllowedUri?: LinkOptions['isAllowedUri'] } = {}): Extensions {
  return [
    StarterKit.configure({ horizontalRule: options.horizontalRule === false ? false : {}, underline: false, link: false, heading: { levels: [1, 2, 3, 4, 5, 6] }, bulletList: false, orderedList: false, listItem: false, listKeymap: false }),
    Link.configure({ openOnClick: false, autolink: true, linkOnPaste: true, protocols: ['http', 'https', 'mailto'], HTMLAttributes: { rel: 'noreferrer', target: '_blank' }, ...(options.isAllowedUri ? { isAllowedUri: options.isAllowedUri } : {}) }),
    ListKit.configure({ taskItem: { nested: true } }),
  ];
}

export function insertionFiles(transfer: DataTransfer | null | undefined, kind: 'images' | 'all') {
  return [...(transfer?.files ?? [])].filter((file) => kind === 'all' || file.type.startsWith('image/') && file.type !== 'image/svg+xml');
}

/** 代码块、行内代码和原文片段中禁用 Markdown 输入规则。 */
export function guardMarkdownRules(extensions: Extensions): Extensions {
  for (const extension of extensions) {
    const holder = extension as unknown as { config?: { addInputRules?: (...args: unknown[]) => unknown[] } };
    const original = holder.config?.addInputRules;
    if (!holder.config || typeof original !== 'function') continue;
    holder.config.addInputRules = function (this: unknown, ...args: unknown[]) {
      const rules = (original.apply(this, args) ?? []) as Array<{ handler?: (state: EditorState, match: RegExpMatchArray, start: number, end: number) => unknown }>;
      return rules.map((rule) => {
        const handler = rule.handler;
        if (typeof handler !== 'function') return rule;
        return {
          ...rule,
          handler(state: EditorState, match: RegExpMatchArray, start: number, end: number) {
            const $from = state.doc.resolve(start);
            if ($from.parent.type.spec.code) return false;
            if ($from.marks().some((mark: { type: { name: string } }) => mark.type.name === 'code')) return false;
            return handler(state, match, start, end);
          },
        };
      });
    };
  }
  return extensions;
}
