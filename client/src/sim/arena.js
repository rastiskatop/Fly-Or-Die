// Fixed logical arena size. The simulation must not depend on the browser window:
// in Lab 5 every client and the server have to agree on the same arena.
// The canvas is scaled with CSS to fit the window (see render/canvas.js).
export const bounds = Object.freeze({ width: 1280, height: 720 });
