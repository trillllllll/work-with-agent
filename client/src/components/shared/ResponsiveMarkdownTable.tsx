import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';

type TableElement = ReactElement<{ children?: ReactNode; colSpan?: number; rowSpan?: number }>;
const elements = (children: ReactNode): TableElement[] => Children.toArray(children).filter(isValidElement<TableElement['props']>);
function textContent(children: ReactNode): string {
  return Children.toArray(children).map(child => isValidElement<{ children?: ReactNode }>(child) ? textContent(child.props.children) : typeof child === 'string' || typeof child === 'number' ? String(child) : '').join('');
}

/** Keep the rendered Markdown nodes, including citations and links, in both layouts. */
export function ResponsiveMarkdownTable({ children }: { children?: ReactNode }) {
  const sections = elements(children);
  const headerSection = sections.find(section => section.type === 'thead');
  const bodySection = sections.find(section => section.type === 'tbody');
  const headerRows = elements(headerSection?.props.children);
  const headers = elements(headerRows[0]?.props.children);
  const rows = elements(bodySection?.props.children).map(row => elements(row.props.children));
  const canStack = headerRows.length === 1 && headers.length >= 3 && headers.every(header => textContent(header.props.children).trim()) && rows.length > 0 && rows.every(row => row.length === headers.length && row.every(cell => !cell.props.colSpan && !cell.props.rowSpan));
  return <div className="markdown-responsive-table" data-stackable={canStack || undefined}>
    <div className="markdown-table-scroll"><table className="w-full border-collapse">{children}</table></div>
    {canStack && <div className="markdown-table-rows">{rows.map((row, index) => <section key={index} className="markdown-table-record">
      <h4>{row[0].props.children}</h4>
      <dl>{row.slice(1).map((cell, column) => <div key={column}><dt>{headers[column + 1].props.children}</dt><dd>{cell.props.children}</dd></div>)}</dl>
    </section>)}</div>}
  </div>;
}
