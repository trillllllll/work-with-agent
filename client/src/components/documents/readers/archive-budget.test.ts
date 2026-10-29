import { expect, it } from 'vitest';
import JSZip from 'jszip';
import { assertOfficeArchiveBudget, verifyOfficeArchiveBudget } from './archive-budget.js';
it('checks Office archive inflated size before parsing', async () => {
  const archive = new JSZip(); archive.file('word/document.xml', '<p>hello</p>');
  const bytes = await archive.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
  expect(assertOfficeArchiveBudget(bytes)).toEqual({ count: 2, inflated: 12 });
  expect(() => assertOfficeArchiveBudget(bytes, 5)).toThrow('READER_BUDGET_EXCEEDED');
  expect(() => assertOfficeArchiveBudget(bytes, 1000, 0)).toThrow('READER_BUDGET_EXCEEDED');
  expect(() => assertOfficeArchiveBudget(new ArrayBuffer(3))).toThrow('INVALID_OFFICE_ARCHIVE');
});
it('bounds real inflate output even when ZIP directory sizes lie', async () => {
  const archive = new JSZip(); archive.file('word/document.xml', `<root>${'a'.repeat(200_000)}</root>`);
  const bytes = await archive.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
  const view = new DataView(bytes);
  for (let index = 0; index < bytes.byteLength - 46; index++) if (view.getUint32(index, true) === 0x02014b50 && view.getUint32(index + 24, true) > 0) view.setUint32(index + 24, 1, true);
  expect(assertOfficeArchiveBudget(bytes, 20_000).inflated).toBe(1);
  await expect(verifyOfficeArchiveBudget(bytes, undefined, 20_000)).rejects.toThrow('READER_BUDGET_EXCEEDED');
});

const worksheetArchive = async (xml: string) => {
  const archive = new JSZip(); archive.file('xl/worksheets/sheet1.xml', xml);
  return archive.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
};
it('accepts bounded worksheets and checks cell coordinates before ExcelJS allocates cells', async () => {
  await expect(verifyOfficeArchiveBudget(await worksheetArchive('<worksheet><dimension ref="A1:XFD1048576"/><sheetData><row r="1"><c r="A1"/><c r="XFD1048576"/></row></sheetData><mergeCells><mergeCell ref="A1:CV100"/></mergeCells></worksheet>'))).resolves.toBeGreaterThan(0);
  for (const part of ['<row r="1048577"/>', '<row><c r="XFE1"/></row>', '<col min="1" max="16385"/>', '<dimension ref="A0:B1"/>']) {
    await expect(verifyOfficeArchiveBudget(await worksheetArchive(`<worksheet>${part}</worksheet>`))).rejects.toThrow('READER_BUDGET_EXCEEDED');
  }
});
it('rejects a tiny XML that asks ExcelJS to instantiate a massive merge range', async () => {
  const bytes = await worksheetArchive('<worksheet><mergeCells><mergeCell ref="A1:XFD1048576"/></mergeCells></worksheet>');
  expect(bytes.byteLength).toBeLessThan(1000);
  await expect(verifyOfficeArchiveBudget(bytes)).rejects.toThrow('READER_BUDGET_EXCEEDED');
});
it('bounds total declared cells, merge area, and worksheet count independently of compressed bytes', async () => {
  await expect(verifyOfficeArchiveBudget(await worksheetArchive(`<worksheet><sheetData><row>${'<c/>'.repeat(200_001)}</row></sheetData></worksheet>`))).rejects.toThrow('READER_BUDGET_EXCEEDED');
  await expect(verifyOfficeArchiveBudget(await worksheetArchive(`<worksheet><mergeCells>${'<mergeCell ref="A1:CV100"/>'.repeat(21)}</mergeCells></worksheet>`))).rejects.toThrow('READER_BUDGET_EXCEEDED');
  const archive = new JSZip();
  for (let index = 0; index < 101; index++) archive.file(`xl/worksheets/sheet${index}.xml`, '<worksheet/>');
  await expect(verifyOfficeArchiveBudget(await archive.generateAsync({ type: 'arraybuffer' }))).rejects.toThrow('READER_BUDGET_EXCEEDED');
  const workbook = new JSZip(); workbook.file('xl/workbook.xml', `<workbook><sheets>${'<sheet/>'.repeat(101)}</sheets></workbook>`);
  await expect(verifyOfficeArchiveBudget(await workbook.generateAsync({ type: 'arraybuffer' }))).rejects.toThrow('READER_BUDGET_EXCEEDED');
});
it('rejects DTD and custom entities in any XML part without expanding them', async () => {
  const archive = new JSZip(); archive.file('word/document.xml', '<!DOCTYPE root [<!ENTITY bomb "expanded">]><root>&bomb;</root>');
  await expect(verifyOfficeArchiveBudget(await archive.generateAsync({ type: 'arraybuffer' }))).rejects.toThrow('INVALID_OFFICE_ARCHIVE');
  await expect(verifyOfficeArchiveBudget(await worksheetArchive('<worksheet>&untrusted;</worksheet>'))).rejects.toThrow('INVALID_OFFICE_ARCHIVE');
});
