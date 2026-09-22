import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import generouted from "@generouted/react-router/plugin";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/**
 * Serve pdf.js's standard-14 font data (Helvetica, Times, Courier) from our
 * own origin at /pdf-fonts/.
 *
 * Report generators routinely reference those fonts without embedding them,
 * and pdf.js needs the metrics to draw them. The files are copied out of
 * node_modules into the bundle rather than fetched from a CDN: the app's CSP
 * allows neither, and a phone in a waiting room has no network anyway. Their
 * licences ride along. See src/lib/pdf.ts.
 */
function pdfStandardFonts(): Plugin {
  const require = createRequire(import.meta.url);
  const dir = join(dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts");
  const base = "/pdf-fonts/";
  return {
    name: "tally-pdf-standard-fonts",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0] ?? "";
        if (!url.startsWith(base)) return next();
        // Only ever a filename in that directory, whatever the request says.
        const file = resolve(dir, decodeURIComponent(url.slice(base.length)));
        if (!file.startsWith(dir + sep)) {
          res.statusCode = 404;
          res.end();
          return;
        }
        void readFile(file).then(
          (buf) => {
            res.setHeader("Content-Type", "application/octet-stream");
            res.end(buf);
          },
          () => {
            // Not falling through: the SPA fallback would answer a missing
            // font with index.html, and pdf.js would try to parse the HTML.
            res.statusCode = 404;
            res.end();
          },
        );
      });
    },
    async generateBundle() {
      for (const name of await readdir(dir)) {
        this.emitFile({
          type: "asset",
          fileName: `pdf-fonts/${name}`,
          source: await readFile(join(dir, name)),
        });
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), generouted(), pdfStandardFonts()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
