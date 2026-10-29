/** Pure in-memory candidate baseline. No HTTP, filesystem fixtures, databases, or production state. */
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import { assertWritableContent, canonicalContent, inspectRichDocument, type RichBlock, type RichDocument } from '../server/src/domain/document-content.js';
import { richDocumentToEditor, editorToRichDocument } from '../client/src/components/documents/richdoc-codec.js';
import { assertOfficeArchiveBudget, verifyOfficeArchiveBudget } from '../client/src/components/documents/readers/archive-budget.js';

type Result = { name: string; bytes: number; samples: number; medianMs: number; p95Ms: number; maxMs: number; retainedHeapDeltaMiB: number };
const results: Result[] = [];
async function measure(name: string, bytes: number, run: () => unknown | Promise<unknown>, count = 7) {
  await run();
  const heapBefore = process.memoryUsage().heapUsed; const values: number[] = [];
  for (let index = 0; index < count; index++) { const start = performance.now(); await run(); values.push(performance.now() - start); }
  values.sort((a, b) => a - b);
  const rounded = (value: number) => Number(value.toFixed(2));
  results.push({ name, bytes, samples: count, medianMs: rounded(values[Math.floor(count / 2)]), p95Ms: rounded(values[Math.ceil(count * 0.95) - 1]), maxMs: rounded(values[count - 1]), retainedHeapDeltaMiB: rounded((process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024) });
}

async function main() {
const text = '中文输入与 document content preservation '.repeat(5);
for (const count of [1_000, 10_000, 20_000]) {
  const content: RichDocument = { schemaVersion: 1, blocks: Array.from({ length: count }, (_, index) => ({ id: `p${index}`, kind: 'paragraph', text: [{ text }] })) };
  assertWritableContent('richdoc-v1', content, 1);
  const bytes = Buffer.byteLength(JSON.stringify(content)); const editor = richDocumentToEditor(content);
  await measure(`${count} paragraphs: schema inspection`, bytes, () => inspectRichDocument(content));
  await measure(`${count} paragraphs: editor serialization + schema + canonical JSON`, bytes, () => canonicalContent(editorToRichDocument(editor)));
}
const table: RichDocument = { schemaVersion: 1, blocks: [{ id: 'table', kind: 'table', children: Array.from({ length: 100 }, (_, row) => ({ id: `row-${row}`, kind: 'tableRow', children: Array.from({ length: 30 }, (_, col): RichBlock => ({ id: `cell-${row}-${col}`, kind: 'tableCell', children: [{ id: `value-${row}-${col}`, kind: 'paragraph', text: [{ text: `${row}:${col}` }] }] })) })) }] };
const tableEditor = richDocumentToEditor(table);
await measure('100 × 30 rich table: editor serialization + schema + canonical JSON', Buffer.byteLength(JSON.stringify(table)), () => canonicalContent(editorToRichDocument(tableEditor)));
const code: RichDocument = { schemaVersion: 1, blocks: [{ id: 'code', kind: 'codeBlock', language: 'typescript', text: [{ text: 'const value = 123;\n'.repeat(110_000) }] }] };
const codeEditor = richDocumentToEditor(code);
await measure('1.98 MB code: editor serialization + schema + canonical JSON', Buffer.byteLength(JSON.stringify(code)), () => canonicalContent(editorToRichDocument(codeEditor)));

const docx = new JSZip();
docx.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
docx.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
docx.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${'<w:p><w:r><w:t>Readable paragraph</w:t></w:r></w:p>'.repeat(10_000)}</w:body></w:document>`);
const docxBytes = await docx.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
const docxBudget = assertOfficeArchiveBudget(docxBytes);
await measure('DOCX 10,000 paragraphs: streaming budget and XML verification', docxBytes.byteLength, () => verifyOfficeArchiveBudget(docxBytes), 3);
await measure('DOCX 10,000 paragraphs: mammoth convertToHtml', docxBytes.byteLength, () => mammoth.convertToHtml({ buffer: Buffer.from(docxBytes) }), 3);
const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('Sample');
for (let row = 0; row < 2_000; row++) sheet.addRow(Array.from({ length: 30 }, (_, col) => `R${row}C${col}`));
const xlsxBytes = new Uint8Array(await workbook.xlsx.writeBuffer()).buffer;
const xlsxBudget = assertOfficeArchiveBudget(xlsxBytes);
await measure('XLSX 2,000 × 30 cells: streaming budget and geometry verification', xlsxBytes.byteLength, () => verifyOfficeArchiveBudget(xlsxBytes), 3);
await measure('XLSX 2,000 × 30 cells: ExcelJS parse', xlsxBytes.byteLength, () => new ExcelJS.Workbook().xlsx.load(xlsxBytes), 3);

const bomb = new JSZip(); bomb.file('word/document.xml', 'x'.repeat(65 * 1024 * 1024));
const bombBytes = await bomb.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
let honestRejected = false;
try { assertOfficeArchiveBudget(bombBytes); } catch (error) { honestRejected = (error as Error).message === 'READER_BUDGET_EXCEEDED'; }
const forged = bombBytes.slice(0), forgedView = new DataView(forged);
for (let offset = 0; offset + 46 <= forged.byteLength; offset++) if (forgedView.getUint32(offset, true) === 0x02014b50 && forgedView.getUint32(offset + 24, true)) forgedView.setUint32(offset + 24, 1, true);
const forgedDeclaredBudget = assertOfficeArchiveBudget(forged);
let parserRejected = false; const inflateStart = performance.now();
try { const parsed = await JSZip.loadAsync(forged); await parsed.file('word/document.xml')!.async('uint8array'); } catch { parserRejected = true; }
const parserTimeMs = Number((performance.now() - inflateStart).toFixed(2));
const giantMerge = new JSZip(); giantMerge.file('xl/worksheets/sheet1.xml', '<worksheet><mergeCells><mergeCell ref="A1:XFD1048576"/></mergeCells></worksheet>');
const giantMergeBytes = await giantMerge.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
let giantMergeRejectedBeforeParser = false; const mergeStart = performance.now();
try { await verifyOfficeArchiveBudget(giantMergeBytes); } catch (error) { giantMergeRejectedBeforeParser = (error as Error).message === 'READER_BUDGET_EXCEEDED'; }

console.log(JSON.stringify({ at: new Date().toISOString(), runtime: process.version, platform: `${process.platform}/${process.arch}`, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, physicalMemoryGiB: os.totalmem() / 1024 ** 3, results, office: { docxBudget, xlsxBudget }, zipBudgetProbe: { realInflatedBytes: 65 * 1024 * 1024, compressedBytes: bombBytes.byteLength, honestRejected, forgedDeclaredBudget, parserRejectedAfterInflation: parserRejected, parserTimeMs }, geometryProbe: { compressedBytes: giantMergeBytes.byteLength, giantMergeRejectedBeforeParser, verificationMs: Number((performance.now() - mergeStart).toFixed(2)) }, processMemoryAtEnd: process.memoryUsage(), caveat: 'Warm in-memory Node samples; excludes DOM, image decode, fetch, IDB, input-to-paint latency and actual peak memory. Heap delta is GC-sensitive, not peak. No database or external service is used.' }, null, 2));
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
