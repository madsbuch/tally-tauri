/**
 * Turning a PDF into page images.
 *
 * Lab results arrive as PDFs as often as they arrive on paper, and the rest of
 * the library already works in images: the vision model reads them, the list
 * shows thumbnails, the detail sheet shows the page. Rendering each page to a
 * JPEG puts a PDF on exactly that path, rather than adding a second one with
 * its own viewer and its own model API.
 *
 * pdf.js runs its parser in a worker. The worker is bundled by Vite and served
 * from the app's own origin, so Tauri's `script-src 'self'` allows it; nothing
 * is fetched from a CDN at runtime, which that CSP would refuse anyway.
 */
// Bundled, not a CDN URL: the worker has to be same-origin under our CSP.
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

// The legacy build, not the default one: pdf.js 6 targets browsers newer than
// the WebView on a phone (it calls Map.prototype.getOrInsertComputed, which
// Chrome 141 still doesn't have). The legacy bundle ships the polyfills.
type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

let pdfjsPromise: Promise<PdfJs> | null = null;

/**
 * Load pdf.js on first use. Half a megabyte of parser has no business in the
 * startup bundle of an app whose main screen is a list of meals — it loads
 * when someone actually opens a PDF, and stays loaded after that.
 */
function loadPdfjs(): Promise<PdfJs> {
  pdfjsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs").then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    return pdfjs;
  });
  return pdfjsPromise;
}

/**
 * Pages past this are dropped. A blood panel is one to four pages; anything
 * far beyond that is a booklet, and sending forty images to a vision model
 * costs a fortune to learn nothing.
 */
export const MAX_PDF_PAGES = 8;

/**
 * Where the standard-14 font data (Helvetica, Times, Courier...) is served
 * from. Report generators routinely reference those fonts without embedding
 * them; pdf.js needs the metrics to draw them, and there is no network on a
 * phone in a waiting room, so they are copied into the bundle from
 * `pdfjs-dist` by a plugin in `vite.config.ts`.
 */
const STANDARD_FONTS_URL = "/pdf-fonts/";

/**
 * Rendered wide enough that small print survives. Lab tables are the whole
 * point of this, and they're set in tiny type — downscaling to the 1280px a
 * meal photo gets would smear the decimal places.
 */
const RENDER_WIDTH = 1700;

const JPEG_QUALITY = 0.9;

export interface PdfPage {
  /** JPEG data URL, for preview and for the vision model. */
  dataUrl: string;
  /** Raw base64 payload, for saving through Rust. */
  base64: string;
}

export interface PdfRenderResult {
  pages: PdfPage[];
  /** Pages in the document, which may exceed what was rendered. */
  totalPages: number;
}

export function isPdf(file: File): boolean {
  return (
    file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")
  );
}

/**
 * Render a PDF's pages to JPEGs, in order.
 *
 * Throws with the underlying reason when the file can't be opened — an
 * encrypted or corrupt PDF is worth reporting, not silently filing as an
 * empty document.
 */
export async function pdfToImages(
  file: Blob,
  maxPages = MAX_PDF_PAGES,
): Promise<PdfRenderResult> {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjs.getDocument({
    data,
    standardFontDataUrl: STANDARD_FONTS_URL,
    // Use the bundled font data rather than whatever the device happens to
    // have installed, so a page renders the same everywhere.
    useSystemFonts: false,
  });

  try {
    const doc = await task.promise;
    const totalPages = doc.numPages;
    const pages: PdfPage[] = [];
    for (let n = 1; n <= Math.min(totalPages, maxPages); n++) {
      const page = await doc.getPage(n);
      const canvas = document.createElement("canvas");
      try {
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({
          scale: Math.max(1, RENDER_WIDTH / base.width),
        });
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        // PDF pages are transparent; without a white ground, a JPEG (which has
        // no alpha) flattens the text onto black.
        await page.render({ canvas, viewport, background: "#ffffff" }).promise;
        const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
        pages.push({ dataUrl, base64: dataUrl.slice(dataUrl.indexOf(",") + 1) });
      } finally {
        page.cleanup();
        // A phone has no memory to spare for eight full-page canvases; drop
        // the backing store as soon as the JPEG is out.
        canvas.width = 0;
        canvas.height = 0;
      }
    }
    return { pages, totalPages };
  } finally {
    // Tears down the worker too, which otherwise outlives every PDF opened.
    await task.destroy();
  }
}
