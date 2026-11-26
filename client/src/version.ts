// The build's version stamp (Lab 8): "0.8.0+a1b2c3d" — package version + git commit, injected by
// Vite at build time (vite.config.ts → define). The server reports its own commit in /health:
// after a deploy, both must show the same commit.
declare const __APP_VERSION__: string | undefined;

export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
