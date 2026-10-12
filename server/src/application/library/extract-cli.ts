import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import sharp from 'sharp';

const xmlLimit = 256 * 1024 * 1024;
const pageLimit = 1000;

type Segment = { text: string; method: 'native' | 'ocr'; locator: Record<string, unknown>; imagePath?: string };
type Failure = { locator: Record<string, unknown> | null; code: string; message: string };
type Result = { status: 'ready' | 'partial' | 'failed' | 'unsupported'; errorCode: string | null; errors: Failure[]; segments: Segment[] };

const decode = (value: string) => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'");

function finish(status: Result['status'], segments: Segment[], errors: Failure[], errorCode: string | null = null): Result {
  if (status === 'ready' && errors.length) status = 'partial';
  return { status, errorCode, errors, segments };
}

async function zipXmlBudget(zip: JSZip) {
  let total = 0;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || !entry.name.toLowerCase().endsWith('.xml')) continue;
    const size = (entry as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    total += size;
    if (total > xmlLimit) return false;
  }
  return true;
}

function paragraphText(block: string) {
  let text = '';
  for (const match of block.matchAll(/<w:tab\/>|<w:br\/>|<w:cr\/>|<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)) {
    if (match[0].startsWith('<w:tab')) text += '\t';
    else if (match[0].startsWith('<w:br') || match[0].startsWith('<w:cr')) text += '\n';
    else text += decode(match[1] ?? '');
  }
  return text;
}

async function readDocx(bytes: Buffer): Promise<Result> {
  const zip = await JSZip.loadAsync(bytes);
  if (!await zipXmlBudget(zip)) return finish('partial', [], [{ locator: null, code: 'XML_LIMIT', message: 'Office 文档解压后的 XML 超过 256 MiB，未继续解析' }], 'XML_LIMIT');
  const file = zip.file('word/document.xml');
  if (!file) return finish('failed', [], [{ locator: null, code: 'FILE_CORRUPT', message: 'DOCX 缺少正文' }], 'FILE_CORRUPT');
  const xml = await file.async('string');
  const segments: Segment[] = [];
  let paragraph = 0;
  for (const match of xml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)) {
    paragraph += 1;
    const text = paragraphText(match[0]);
    if (!text.trim()) continue;
    segments.push({ text, method: 'native', locator: { kind: 'paragraph', paragraph } });
  }
  return finish('ready', segments, []);
}

function slideText(xml: string) {
  const parts: string[] = [];
  for (const paragraph of xml.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)) {
    const text = [...paragraph[0].matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)].map((match) => decode(match[1] ?? '')).join('');
    if (text) parts.push(text);
  }
  return parts;
}

async function readPptx(bytes: Buffer): Promise<Result> {
  const zip = await JSZip.loadAsync(bytes);
  if (!await zipXmlBudget(zip)) return finish('partial', [], [{ locator: null, code: 'XML_LIMIT', message: 'Office 文档解压后的 XML 超过 256 MiB，未继续解析' }], 'XML_LIMIT');
  const presentation = await zip.file('ppt/presentation.xml')?.async('string');
  const rels = await zip.file('ppt/_rels/presentation.xml.rels')?.async('string');
  if (!presentation || !rels) return finish('failed', [], [{ locator: null, code: 'FILE_CORRUPT', message: 'PPTX 缺少幻灯片目录' }], 'FILE_CORRUPT');
  const targets = new Map<string, string>();
  for (const match of rels.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)) targets.set(match[1], match[2].replace(/^\//, ''));
  const segments: Segment[] = [];
  let slide = 0;
  for (const match of presentation.matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)) {
    slide += 1;
    const target = targets.get(match[1]);
    if (!target) continue;
    const path = target.startsWith('ppt/') ? target : `ppt/${target.replace(/^\.\.\//, '')}`;
    const xml = await zip.file(path)?.async('string');
    if (!xml) continue;
    const parts = slideText(xml);
    const relPath = path.replace('ppt/slides/', 'ppt/slides/_rels/') + '.rels';
    const slideRels = await zip.file(relPath)?.async('string');
    const notesTarget = slideRels?.match(/Target="([^"]*notesSlide[^"]+)"/)?.[1];
    if (notesTarget) {
      const notesPath = notesTarget.startsWith('../') ? `ppt/${notesTarget.slice(3)}` : notesTarget;
      const notes = await zip.file(notesPath)?.async('string');
      if (notes) parts.push(...slideText(notes));
    }
    const text = parts.join('\n');
    if (text.trim()) segments.push({ text, method: 'native', locator: { kind: 'slide', slide } });
  }
  return finish('ready', segments, []);
}

function cellText(value: ExcelJS.CellValue) {
  if (value == null) return '';
  if (typeof value === 'object' && 'formula' in value) {
    const formula = value as { formula?: string; result?: ExcelJS.CellValue };
    if (formula.result != null && formula.result !== '') return cellText(formula.result);
    return formula.formula ? `公式:${formula.formula}` : '';
  }
  if (typeof value === 'object' && 'richText' in value) return (value.richText ?? []).map((part) => part.text).join('');
  if (typeof value === 'object' && 'text' in value && typeof value.text === 'string') return value.text;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object' && 'error' in value) return '';
  return String(value);
}

async function readXlsx(bytes: Buffer): Promise<Result> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  const segments: Segment[] = [];
  workbook.eachSheet((sheet) => {
    sheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const text = cellText(cell.value).trim();
        if (!text) return;
        const address = cell.address;
        segments.push({ text, method: 'native', locator: { kind: 'sheet', sheet: sheet.name, startCell: address, endCell: address } });
      });
    });
  });
  return finish('ready', segments, []);
}

async function readPdf(bytes: Buffer, outDir: string): Promise<Result> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as { getDocument: (src: unknown) => { promise: Promise<{ numPages: number; getPage: (n: number) => Promise<PdfPage> }> } };
  let doc: { numPages: number; getPage: (n: number) => Promise<PdfPage> };
  try {
    doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableWorker: true, isEvalSupported: false, useSystemFonts: true }).promise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const password = /password/i.test(message);
    return finish('failed', [], [{ locator: null, code: password ? 'PASSWORD_PROTECTED' : 'FILE_CORRUPT', message: password ? 'PDF 受密码保护' : 'PDF 无法读取' }], password ? 'PASSWORD_PROTECTED' : 'FILE_CORRUPT');
  }
  const segments: Segment[] = [];
  const errors: Failure[] = [];
  const last = Math.min(doc.numPages, pageLimit);
  for (let page = 1; page <= last; page += 1) {
    try {
      const pdfPage = await doc.getPage(page);
      const content = await pdfPage.getTextContent();
      let text = '';
      for (const item of content.items) {
        if (item && typeof item === 'object' && 'str' in item) text += `${String(item.str)}${item.hasEOL ? '\n' : ''}`;
      }
      if (text.replace(/\s/g, '').length >= 20) segments.push({ text, method: 'native', locator: { kind: 'page', page } });
      else {
        const imagePath = await renderPage(pdfPage, outDir, page);
        segments.push({ text: '', method: 'ocr', locator: { kind: 'page', page }, imagePath });
      }
    } catch (error) {
      errors.push({ locator: { kind: 'page', page, start: 0, end: 0 }, code: 'PAGE_FAILED', message: error instanceof Error ? error.message : '这一页无法读取' });
    }
  }
  if (doc.numPages > pageLimit) errors.push({ locator: null, code: 'PAGE_LIMIT', message: `未处理第 ${pageLimit + 1}–${doc.numPages} 页` });
  if (!segments.length && errors.length) return finish('failed', [], errors, errors[0]?.code ?? 'FILE_CORRUPT');
  return finish('ready', segments, errors);
}

type PdfPage = { getTextContent: () => Promise<{ items: Array<{ str?: string; hasEOL?: boolean }> }>; getViewport: (input: { scale: number }) => { width: number; height: number }; render: (input: { canvasContext: unknown; viewport: { width: number; height: number } }) => { promise: Promise<void> } };

async function renderPage(page: PdfPage, outDir: string, number: number) {
  const { createCanvas } = await import('@napi-rs/canvas');
  const base = page.getViewport({ scale: 144 / 72 });
  const longest = Math.max(base.width, base.height);
  const scale = longest > 2000 ? (144 / 72) * (2000 / longest) : 144 / 72;
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  const imagePath = resolve(outDir, `page-${number}.png`);
  await writeFile(imagePath, canvas.toBuffer('image/png'));
  return imagePath;
}

async function readImage(bytes: Buffer, outDir: string, fileName: string): Promise<Result> {
  const gif = fileName.toLowerCase().endsWith('.gif');
  const image = sharp(bytes, { animated: false, pages: 1 });
  const meta = await image.metadata();
  const width = meta.width ?? 1;
  const height = meta.height ?? 1;
  const longest = Math.max(width, height);
  const resized = longest > 2000 ? image.resize({ width: width >= height ? 2000 : undefined, height: height > width ? 2000 : undefined, fit: 'inside', withoutEnlargement: true }) : image;
  const imagePath = resolve(outDir, 'image.png');
  await writeFile(imagePath, await resized.png().toBuffer());
  const errors: Failure[] = gif ? [{ locator: { kind: 'image', image: 1, start: 0, end: 0 }, code: 'GIF_FIRST_FRAME', message: 'GIF 只读取第一帧' }] : [];
  return finish('ready', [{ text: '', method: 'ocr', locator: { kind: 'image', image: 1 }, imagePath }], errors);
}

function readText(bytes: Buffer): Result {
  const text = bytes.toString('utf8');
  if (text.includes('\u0000')) return finish('failed', [], [{ locator: null, code: 'FILE_CORRUPT', message: '文本不是 UTF-8' }], 'FILE_CORRUPT');
  const segments: Segment[] = [];
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    if (!line && index === lines.length - 1) return;
    segments.push({ text: line, method: 'native', locator: { kind: 'line', startLine: index + 1, endLine: index + 1 } });
  });
  return finish('ready', segments, []);
}

function extensionOf(fileName: string) {
  const dot = fileName.lastIndexOf('.');
  return dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : '';
}

async function extract(bytes: Buffer, fileName: string, mimeType: string, kind: string, outDir: string): Promise<Result> {
  const extension = extensionOf(fileName);
  try {
    if (kind === 'text' || kind === 'markdown' || ['txt', 'md', 'markdown', 'csv', 'json', 'log'].includes(extension) || mimeType.startsWith('text/')) return readText(bytes);
    if (extension === 'docx' || mimeType.includes('wordprocessingml')) return readDocx(bytes);
    if (extension === 'xlsx' || mimeType.includes('spreadsheetml')) return readXlsx(bytes);
    if (extension === 'pptx' || mimeType.includes('presentationml')) return readPptx(bytes);
    if (extension === 'pdf' || mimeType === 'application/pdf') return readPdf(bytes, outDir);
    if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension) || ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mimeType)) return readImage(bytes, outDir, fileName);
    if (['doc', 'xls', 'ppt'].includes(extension)) return finish('unsupported', [], [{ locator: null, code: 'UNSUPPORTED', message: '暂不支持旧版二进制 Office 文档的正文解析' }], 'UNSUPPORTED');
    return finish('unsupported', [], [{ locator: null, code: 'UNSUPPORTED', message: '暂不支持此格式的正文解析' }], 'UNSUPPORTED');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const password = /password/i.test(message);
    return finish('failed', [], [{ locator: null, code: password ? 'PASSWORD_PROTECTED' : 'FILE_CORRUPT', message }], password ? 'PASSWORD_PROTECTED' : 'FILE_CORRUPT');
  }
}

async function main() {
  const jobPath = process.argv[2];
  const resultPath = process.argv[3];
  const job = JSON.parse(await readFile(jobPath, 'utf8')) as { bytesPath: string; outDir: string; fileName: string; mimeType: string; kind: string };
  await mkdir(job.outDir, { recursive: true });
  const bytes = await readFile(job.bytesPath);
  const result = await extract(bytes, job.fileName, job.mimeType, job.kind, job.outDir);
  await writeFile(resultPath, JSON.stringify(result));
}

if (process.argv[1] && (process.argv[1].endsWith('extract-cli.ts') || process.argv[1].endsWith('extract-cli.js'))) {
  main().catch(async (error) => {
    const resultPath = process.argv[3];
    const result: Result = { status: 'failed', errorCode: 'FILE_CORRUPT', errors: [{ locator: null, code: 'FILE_CORRUPT', message: error instanceof Error ? error.message : String(error) }], segments: [] };
    if (resultPath) await writeFile(resultPath, JSON.stringify(result)).catch(() => undefined);
    process.exitCode = 1;
  });
}
