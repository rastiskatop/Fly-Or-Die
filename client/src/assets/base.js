// Where do the static files (the `public/` folder) live? It depends on WHO serves the page:
//
//   Vite dev server / `vite build` → public/ is mapped to the site root:  /assets/manifest.json
//   any plain static server         → files are served as they are:       /public/assets/manifest.json
//   (VS Code Live Server, `npx serve`, GitHub Pages from the repo, …)
//
// Vite replaces `import.meta.env` at build/serve time; a plain static server leaves it undefined.
// So we resolve paths against Vite's BASE_URL when it exists, and against THIS module's own URL
// otherwise. Both work under a sub-path (e.g. https://user.github.io/Fly-Or-Die/).

export const SERVED_BY_VITE = Boolean(import.meta.env);

/** true in `vite` dev and when served raw (both are development); false in a production build. */
export const IS_DEV = SERVED_BY_VITE ? Boolean(import.meta.env.DEV) : true;

/** Vite's dev-only test endpoints (/__delay, /__flaky, ...) exist only under `npm run dev`. */
export const HAS_TEST_ENDPOINTS = SERVED_BY_VITE && Boolean(import.meta.env.DEV);

const STATIC_ROOT = SERVED_BY_VITE
  ? new URL(import.meta.env.BASE_URL, location.href).href
  : new URL('../../public/', import.meta.url).href; // src/assets/base.js → <project>/public/

/** Absolute URL of a file from public/, e.g. staticUrl('assets/manifest.json'). */
export function staticUrl(path) {
  return new URL(path, STATIC_ROOT).href;
}

/** Short form for logs and UI: path without origin. */
export function shortUrl(url) {
  try {
    const u = new URL(url, location.href);
    return u.origin === location.origin ? u.pathname.replace(/^\//, '') : url;
  } catch {
    return url;
  }
}
