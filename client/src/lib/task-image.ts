import compressionLibUrl from 'browser-image-compression/dist/browser-image-compression.js?url';
import { t } from '../i18n/index.js';

const maxEdge = 2560;
const limit = 3 * 1024 * 1024;

export function isRasterImage(file: File) {
  return file.type.startsWith('image/') && file.type !== 'image/svg+xml';
}

export function imageMime(bytes: Uint8Array): 'image/webp' | 'image/jpeg' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function ascii(bytes: Uint8Array, start: number, end: number) {
  let text = '';
  for (let index = start; index < end; index += 1) text += String.fromCharCode(bytes[index]);
  return text;
}

async function mimeOf(file: Blob) {
  return imageMime(new Uint8Array(await file.slice(0, 12).arrayBuffer()));
}

/** Width and height after each halving, then the final fit inside maxEdge. Empty when no resize is needed. */
export function downscaleSteps(width: number, height: number, edge = maxEdge) {
  if (width <= 0 || height <= 0 || Math.max(width, height) <= edge) return [];
  const steps: { width: number; height: number }[] = [];
  let currentWidth = width;
  let currentHeight = height;
  while (Math.max(currentWidth, currentHeight) / 2 > edge) {
    currentWidth = Math.round(currentWidth / 2);
    currentHeight = Math.round(currentHeight / 2);
    steps.push({ width: currentWidth, height: currentHeight });
  }
  const scale = edge / Math.max(width, height);
  steps.push({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) });
  return steps;
}

async function sizedSource(file: File) {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file;
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { return file; }
  try {
    const steps = downscaleSteps(bitmap.width, bitmap.height);
    if (!steps.length) return file;
    const canvases = [document.createElement('canvas'), document.createElement('canvas')];
    let source: CanvasImageSource = bitmap;
    let drawn: HTMLCanvasElement | null = null;
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      const canvas = canvases[index % 2];
      canvas.width = step.width;
      canvas.height = step.height;
      const context = canvas.getContext('2d');
      if (!context) return file;
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(source, 0, 0, step.width, step.height);
      source = canvas;
      drawn = canvas;
    }
    const finished = drawn;
    if (!finished) return file;
    const blob = await new Promise<Blob | null>((resolve) => finished.toBlob(resolve, 'image/png'));
    if (!blob) return file;
    return new File([blob], file.name, { type: 'image/png', lastModified: file.lastModified });
  } finally {
    bitmap.close();
  }
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(t('app:taskImage.timeout'))), timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(t('app:taskImage.compressFailed')));
      },
    );
  });
}

function blobBytes(blob: Blob, timeoutMs: number) {
  return withTimeout(blob.arrayBuffer().then((buffer) => new Uint8Array(buffer)), timeoutMs);
}

async function encode(file: File, fileType: 'image/webp' | 'image/jpeg') {
  const imageCompression = (await import('browser-image-compression')).default;
  const options = { maxSizeMB: 3, maxWidthOrHeight: maxEdge, alwaysKeepResolution: true, fileType, initialQuality: 0.92, libURL: new URL(compressionLibUrl, window.location.href).href };
  const run = (useWebWorker: boolean) => imageCompression(file, { ...options, useWebWorker });
  // WebKit 的 Worker 可能不返回，或把 WebP 原样交回成 PNG。WebP 失败就抛出，由调用方改压 JPEG；JPEG 再改走主线程。
  let compressed: Blob;
  try { compressed = await withTimeout(run(true), 4_000); }
  catch (error) {
    if (fileType === 'image/webp') throw error;
    compressed = await withTimeout(run(false), 8_000);
  }
  let bytes: Uint8Array;
  try { bytes = await blobBytes(compressed, 2_000); }
  catch (error) {
    if (fileType === 'image/webp') throw error;
    compressed = await withTimeout(run(false), 8_000);
    bytes = await blobBytes(compressed, 4_000);
  }
  const mimeType = imageMime(bytes);
  if (mimeType !== fileType) throw new Error(fileType === 'image/webp' ? t('app:taskImage.notWebp') : t('app:taskImage.notJpeg'));
  const stem = file.name.replace(/\.[^.]+$/, '') || 'image';
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return new File([copy], `${stem}.${mimeType === 'image/webp' ? 'webp' : 'jpg'}`, { type: mimeType, lastModified: file.lastModified });
}

/** Shrink a pasted or chosen image before upload. Animated images become one still frame. */
export async function compressTaskImage(file: File) {
  if (!isRasterImage(file)) throw new Error(t('app:taskImage.imagesOnly'));
  const prepared = await sizedSource(file);
  let compressed: File;
  try { compressed = await encode(prepared, 'image/webp'); }
  catch { compressed = await encode(prepared, 'image/jpeg'); }
  let mimeType = await mimeOf(compressed);
  if (!mimeType) {
    compressed = await encode(prepared, 'image/jpeg');
    mimeType = await mimeOf(compressed);
  }
  if (!mimeType) throw new Error(t('app:taskImage.convertFailed'));
  if (compressed.size > limit) throw new Error(t('app:taskImage.stillTooLarge'));
  return { file: compressed, mimeType } as const;
}

export function fileToBase64(file: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result ?? '');
      const comma = value.indexOf(',');
      resolve(comma >= 0 ? value.slice(comma + 1) : value);
    };
    reader.onerror = () => reject(reader.error ?? new Error(t('app:taskImage.unreadable')));
    reader.readAsDataURL(file);
  });
}
