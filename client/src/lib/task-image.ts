import compressionLibUrl from 'browser-image-compression/dist/browser-image-compression.js?url';

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

async function encode(file: File, fileType: 'image/webp' | 'image/jpeg') {
  const imageCompression = (await import('browser-image-compression')).default;
  const options = { maxSizeMB: 3, maxWidthOrHeight: maxEdge, alwaysKeepResolution: true, fileType, initialQuality: 0.92, useWebWorker: true, libURL: new URL(compressionLibUrl, window.location.href).href };
  try { return await imageCompression(file, options); }
  catch { return await imageCompression(file, { ...options, useWebWorker: false }); }
}

/** Shrink a pasted or chosen image before upload. Animated images become one still frame. */
export async function compressTaskImage(file: File) {
  if (!isRasterImage(file)) throw new Error('只支持图片');
  const prepared = await sizedSource(file);
  let compressed: File;
  try { compressed = await encode(prepared, 'image/webp'); }
  catch { compressed = await encode(prepared, 'image/jpeg'); }
  let mimeType = await mimeOf(compressed);
  if (!mimeType) {
    compressed = await encode(prepared, 'image/jpeg');
    mimeType = await mimeOf(compressed);
  }
  if (!mimeType) throw new Error('图片没能转成 WebP 或 JPEG');
  if (compressed.size > limit) throw new Error('图片压缩后仍超过 3 MiB');
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
    reader.onerror = () => reject(reader.error ?? new Error('无法读取图片'));
    reader.readAsDataURL(file);
  });
}
