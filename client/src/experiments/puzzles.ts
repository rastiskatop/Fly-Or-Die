// Lab 3, M4: five self-written ordering puzzles. Open the game with ?demo=puzzles and
// read the console — each puzzle prints the ACTUAL order next to the predicted one.

const tick = () => new Promise((r) => setTimeout(r, 50)); // let every queue drain between puzzles

interface Puzzle {
  readonly name: string;
  readonly expected: string;
  run(log: (x: unknown) => void): void | Promise<unknown>;
}

const puzzles: readonly Puzzle[] = [
  {
    name: '1. await yields even for a non-promise',
    expected: 'a f1 b f2 p',
    run(log: (x: unknown) => void): void | Promise<unknown> {
      async function f() {
        log('f1');
        await undefined; // the rest of f becomes a microtask
        log('f2');
      }
      log('a');
      f();
      Promise.resolve().then(() => log('p'));
      log('b');
    },
  },
  {
    name: '2. setTimeout scheduled inside .then',
    expected: 's p1 p2 t1 t2',
    run(log: (x: unknown) => void): void | Promise<unknown> {
      setTimeout(() => log('t1'), 0);
      Promise.resolve()
        .then(() => {
          log('p1');
          setTimeout(() => log('t2'), 0); // queued AFTER t1, which is already waiting
        })
        .then(() => log('p2'));
      log('s');
    },
  },
  {
    name: '3. microtasks drain between two requestAnimationFrame callbacks',
    expected: 'sync m0 raf1 m1 raf2',
    run(log: (x: unknown) => void): void | Promise<unknown> {
      requestAnimationFrame(() => {
        log('raf1');
        queueMicrotask(() => log('m1')); // runs before raf2, although both rAFs are "the same frame"
      });
      requestAnimationFrame(() => log('raf2'));
      queueMicrotask(() => log('m0'));
      log('sync');
      return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    },
  },
  {
    name: '4. async function returning a promise costs extra ticks',
    expected: 'x1 g x2 h x3',
    run(log: (x: unknown) => void): void | Promise<unknown> {
      async function g() {
        return 'g'; // plain value: the async promise is fulfilled immediately
      }
      async function h() {
        return Promise.resolve('h'); // a promise: adopted via an extra then-job → 2 more ticks
      }
      h().then(log);
      Promise.resolve()
        .then(() => log('x1'))
        .then(() => log('x2'))
        .then(() => log('x3'));
      g().then(log);
    },
  },
  {
    name: '5. a rejection skips .then, catch/finally interleave with another chain',
    expected: 'ok1 catch:boom ok2 finally ok3',
    run(log: (x: unknown) => void): void | Promise<unknown> {
      Promise.reject(new Error('boom'))
        .then(() => log('then')) // skipped, but still takes one microtask to pass the rejection on
        .catch((e) => log(`catch:${e.message}`))
        .finally(() => log('finally'));
      Promise.resolve()
        .then(() => log('ok1'))
        .then(() => log('ok2'))
        .then(() => log('ok3'));
    },
  },
];

export interface PuzzleResult {
  readonly puzzle: string;
  readonly expected: string;
  readonly actual: string;
  readonly ok: boolean;
}

export async function runPuzzles(): Promise<PuzzleResult[]> {
  console.group('[Lab 3] ordering puzzles');
  const results: PuzzleResult[] = [];
  for (const p of puzzles) {
    const out: string[] = [];
    const waitFor = p.run((x: unknown) => void out.push(String(x)));
    await waitFor;
    await tick();
    const actual = out.join(' ');
    results.push({ puzzle: p.name, expected: p.expected, actual, ok: actual === p.expected });
  }
  console.table(results);
  console.groupEnd();
  return results;
}
