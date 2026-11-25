const maxCanvasPixels = 16_000_000;
const maxCanvasEdge = 30_000;
const qualities = [0.92, 0.85, 0.78];

/** Stay at full resolution when possible. For long screenshots, protect the width of the text. */
export async function compressHarnessImage(file: File, byteLimit: number): Promise<File | null> {
  const url = URL.createObjectURL(file);
  const canvas = document.createElement('canvas');
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Image could not be decoded'));
      image.src = url;
    });
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (!width || !height) return null;
    const shortEdge = Math.min(width, height);
    const longEdge = Math.max(width, height);
    const minimumScale = Math.min(1, (longEdge >= shortEdge * 3 ? 960 : 640) / shortEdge);
    let scale = Math.min(1, Math.sqrt(maxCanvasPixels / (width * height)), maxCanvasEdge / longEdge);
    while (scale >= minimumScale) {
      canvas.width = Math.max(1, Math.floor(width * scale));
      canvas.height = Math.max(1, Math.floor(height * scale));
      const context = canvas.getContext('2d', { alpha: false });
      if (context) {
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.imageSmoothingQuality = 'high';
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        for (const quality of qualities) {
          const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
          if (blob?.type === 'image/jpeg' && blob.size > 0 && blob.size <= byteLimit) {
            const stem = (file.name.replace(/\.[^.]+$/, '') || 'image').slice(0, 251);
            return new File([blob], stem + '.jpg', { type: 'image/jpeg', lastModified: file.lastModified });
          }
        }
      }
      if (scale === minimumScale) break;
      scale = Math.max(minimumScale, scale * 0.85);
    }
    return null;
  } finally {
    canvas.width = canvas.height = 1;
    URL.revokeObjectURL(url);
  }
}
