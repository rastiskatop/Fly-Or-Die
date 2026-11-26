// Turning V8 profiles (the same JSON DevTools opens) into tables and a flame chart.
// Shared by the client profiler (CDP) and the server profiler (node --cpu-prof).
import { z } from 'zod';

const CallFrameSchema = z
  .object({
    functionName: z.string(),
    url: z.string(),
    lineNumber: z.number(),
    columnNumber: z.number(),
  })
  .loose();

export const CpuProfileSchema = z
  .object({
    nodes: z.array(
      z
        .object({
          id: z.number(),
          callFrame: CallFrameSchema,
          hitCount: z.number().optional(),
          children: z.array(z.number()).optional(),
        })
        .loose(),
    ),
    startTime: z.number(),
    endTime: z.number(),
    samples: z.array(z.number()).optional(),
  })
  .loose();
export type CpuProfile = z.infer<typeof CpuProfileSchema>;

interface HeapNode {
  callFrame: z.infer<typeof CallFrameSchema>;
  selfSize: number;
  children: HeapNode[];
}
const HeapNodeSchema: z.ZodType<HeapNode> = z.lazy(() =>
  z.object({ callFrame: CallFrameSchema, selfSize: z.number(), children: z.array(HeapNodeSchema) }),
);
export const HeapProfileSchema = z.object({ head: HeapNodeSchema }).loose();
export type HeapProfile = z.infer<typeof HeapProfileSchema>;

/** "fn (file.ts:line)" — the same identity DevTools' Bottom-Up view groups by. */
export function frameName(cf: { functionName: string; url: string; lineNumber: number }): string {
  const file = cf.url.split(/[\\/]/).pop()?.split('?')[0] ?? '';
  const fn = cf.functionName || '(anonymous)';
  return file ? `${fn} (${file}:${cf.lineNumber + 1})` : fn;
}

export interface SelfTime {
  readonly fn: string;
  readonly selfMs: number;
  readonly pct: number;
}

/** Bottom-Up: self time per function. (idle) and (program) are reported but are not "our" time. */
export function topSelfTime(
  profile: CpuProfile,
  n: number,
  skip: readonly string[] = ['(idle)', '(program)', '(root)'],
): SelfTime[] {
  const totalHits = profile.nodes.reduce((s, node) => s + (node.hitCount ?? 0), 0) || 1;
  const msPerHit = (profile.endTime - profile.startTime) / 1000 / totalHits;
  const byFn = new Map<string, number>();
  for (const node of profile.nodes) {
    const name = frameName(node.callFrame);
    byFn.set(name, (byFn.get(name) ?? 0) + (node.hitCount ?? 0));
  }
  return [...byFn]
    .filter(([fn]) => !skip.includes(fn))
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([fn, hits]) => ({ fn, selfMs: hits * msPerHit, pct: (100 * hits) / totalHits }));
}

/** Who allocated the most bytes during the recording (sampled; includes objects already collected). */
export function topAllocators(profile: HeapProfile, n: number): { fn: string; bytes: number }[] {
  const byFn = new Map<string, number>();
  const walk = (node: HeapNode): void => {
    const name = frameName(node.callFrame);
    if (node.selfSize > 0) byFn.set(name, (byFn.get(name) ?? 0) + node.selfSize);
    for (const c of node.children) walk(c);
  };
  walk(profile.head);
  return [...byFn]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([fn, bytes]) => ({ fn, bytes }));
}

const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * A flame chart (icicle: callers on top) from a CPU profile: width = total time in that call path.
 * (idle) is dropped so the chart shows where the BUSY time went.
 */
export function flameChartSvg(profile: CpuProfile, title: string, width = 1200): string {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const total = new Map<number, number>();
  const totalOf = (id: number): number => {
    const cached = total.get(id);
    if (cached !== undefined) return cached;
    const node = byId.get(id);
    if (!node || node.callFrame.functionName === '(idle)') return 0;
    let t = node.hitCount ?? 0;
    for (const c of node.children ?? []) t += totalOf(c);
    total.set(id, t);
    return t;
  };
  const root = profile.nodes[0];
  if (!root) return '<svg xmlns="http://www.w3.org/2000/svg"/>';
  const rootTotal = totalOf(root.id) || 1;
  const ROW = 17;
  const rects: string[] = [];
  let maxDepth = 0;
  const color = (url: string, name: string): string => {
    if (name === '(garbage collector)') return '#e8a33d';
    if (/\/(src|client|shared|server)\//.test(url) || /\.ts/.test(url)) return '#5b9a52';
    if (!url) return '#9a9a9a';
    return '#6f8fb3';
  };
  const draw = (id: number, x: number, depth: number): void => {
    const node = byId.get(id);
    const t = totalOf(id);
    if (!node || t === 0) return;
    const w = (t / rootTotal) * width;
    if (w < 0.6) return;
    maxDepth = Math.max(maxDepth, depth);
    const name = frameName(node.callFrame);
    const y = 30 + depth * ROW;
    const label =
      w > 40
        ? `<text x="${(x + 3).toFixed(1)}" y="${y + 12}" clip-path="url(#c${id})">${escapeXml(name)}</text>`
        : '';
    rects.push(
      `<clipPath id="c${id}"><rect x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${ROW - 1}"/></clipPath>` +
        `<g><title>${escapeXml(name)} — ${((100 * t) / rootTotal).toFixed(1)} %</title><rect x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${ROW - 1}" fill="${color(node.callFrame.url, node.callFrame.functionName)}" rx="2"/>${label}</g>`,
    );
    let cx = x;
    for (const c of node.children ?? []) {
      draw(c, cx, depth + 1);
      cx += (totalOf(c) / rootTotal) * width;
    }
  };
  draw(root.id, 0, 0);
  const height = 30 + (maxDepth + 1) * ROW + 24;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="system-ui, sans-serif" font-size="11" fill="#111">
<rect width="100%" height="100%" fill="#fafafa"/>
<text x="4" y="18" font-size="13" font-weight="600">${escapeXml(title)} — busy time only (idle removed); green = game code, blue = browser/runtime, orange = GC</text>
${rects.join('\n')}
</svg>
`;
}
