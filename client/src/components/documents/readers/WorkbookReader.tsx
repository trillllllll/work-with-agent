import { useEffect, useMemo, useState } from 'react';
import ExcelJS from 'exceljs';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { NativeSelect } from '@/components/ui/native-select.js';
import { TableRow } from '@/components/ui/table-row.js';
import { useTranslation } from 'react-i18next';
import { parseWorkbookRange } from './navigation.js';

export default function WorkbookReader({ bytes }: { bytes: ArrayBuffer }) {
  const { t } = useTranslation('library'); const [workbook, setWorkbook] = useState<ExcelJS.Workbook | null>(null); const [sheetId, setSheetId] = useState(0);
  const [error, setError] = useState(''); const [start, setStart] = useState({ row: 1, col: 1 }); const [address, setAddress] = useState('A1');
  const [addressInvalid, setAddressInvalid] = useState(false);
  useEffect(() => { let alive = true; const book = new ExcelJS.Workbook(); setWorkbook(null); setError(''); void book.xlsx.load(bytes).then(() => { if (alive) { setWorkbook(book); setSheetId(book.worksheets[0]?.id ?? 0); } }).catch(() => { if (alive) setError(t('docsReader.failed')); }); return () => { alive = false; }; }, [bytes]);
  const sheet = workbook?.getWorksheet(sheetId);
  const locate = () => { if (!sheet) return; const range = parseWorkbookRange(address); setAddressInvalid(!range); if (range) setStart(range.start); };
  const rows = sheet ? Array.from({ length: Math.min(100, Math.max(0, sheet.rowCount - start.row + 1)) }, (_, index) => start.row + index) : [];
  const columns = sheet ? Array.from({ length: Math.min(30, Math.max(0, sheet.columnCount - start.col + 1)) }, (_, index) => start.col + index) : [];
  const merges = useMemo(() => {
    const visible = new Map<string, { rowSpan: number; colSpan: number; text: string } | null>();
    if (!sheet) return visible;
    for (const address of (sheet.model.merges ?? []).slice(0, 10_000)) {
      const [first, last] = address.split(':'); const from = sheet.getCell(first); const to = sheet.getCell(last || first);
      const top = Math.max(start.row, Number(from.row)); const bottom = Math.min(start.row + 99, Number(to.row));
      const left = Math.max(start.col, Number(from.col)); const right = Math.min(start.col + 29, Number(to.col));
      if (top > bottom || left > right) continue;
      for (let row = top; row <= bottom; row++) for (let col = left; col <= right; col++) visible.set(`${row}:${col}`, null);
      visible.set(`${top}:${left}`, { rowSpan: bottom - top + 1, colSpan: right - left + 1, text: from.text });
    }
    return visible;
  }, [sheet, start]);
  return <div className="document-workbook-reader">
    <p>{t('docsReader.xlsxNote')}</p>
    {error && <p role="alert">{error}</p>}
    <div className="document-reader-toolbar">
      <NativeSelect aria-label={t('docsReader.worksheet')} value={sheetId} onChange={(event) => { setSheetId(Number(event.target.value)); setStart({ row: 1, col: 1 }); }}>{workbook?.worksheets.map((sheet) => <option key={sheet.id} value={sheet.id}>{sheet.name}</option>)}</NativeSelect>
      <Input aria-label={t('docsReader.range')} aria-invalid={addressInvalid} value={address} onChange={(event) => { setAddress(event.target.value); setAddressInvalid(false); }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) locate(); }} />
      <Button variant="ghost" size="sm" onClick={locate}>{t('docsReader.locate')}</Button>
      <Button variant="ghost" size="sm" disabled={start.row <= 1} onClick={() => setStart((value) => ({ ...value, row: Math.max(1, value.row - 100) }))}>{t('docsReader.previous')}</Button>
      <Button variant="ghost" size="sm" disabled={!sheet || start.row + 100 > sheet.rowCount} onClick={() => setStart((value) => ({ ...value, row: value.row + 100 }))}>{t('docsReader.next')}</Button>
      {sheet && rows.length > 0 && <span>{start.row}–{Math.min(sheet.rowCount, start.row + 99)} / {sheet.rowCount}</span>}
    </div>
    {addressInvalid && <p role="alert">{t('docsReader.invalidRange')}</p>}
    {sheet && (!rows.length || !columns.length) && <p>{t('docsReader.emptyRange')}</p>}
    <div className="document-workbook-grid"><table><thead><TableRow><th />{columns.map((col) => <th key={col}>{sheet?.getColumn(col).letter}</th>)}</TableRow></thead><tbody>{rows.map((row) => <TableRow key={row}><th>{row}</th>{columns.map((col) => { const cell = sheet!.getCell(row, col); const merge = merges.get(`${row}:${col}`); if (merge === null) return null; return <td key={col} rowSpan={merge?.rowSpan} colSpan={merge?.colSpan} title={cell.isMerged ? `${cell.address} → ${cell.master.address}` : cell.address} data-merged={cell.isMerged || undefined}>{merge?.text ?? cell.text}</td>; })}</TableRow>)}</tbody></table></div>
  </div>;
}
