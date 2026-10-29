export function pdfjsAssetUrls(version: string, base = import.meta.env.BASE_URL) {
  const root = `${base}pdfjs/${version}/`;
  return { cMapUrl: `${root}cmaps/`, cMapPacked: true, standardFontDataUrl: `${root}standard_fonts/`, wasmUrl: `${root}wasm/` };
}
