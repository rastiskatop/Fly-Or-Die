import { describeError } from '../assets/net.js';
import { shortUrl } from '../assets/base.js';

const NEON = '#00ff66';

/**
 * Canvas loading screen with a real progress bar.
 * Runs `load({ signal, onProgress })` and resolves with its result.
 * - Esc aborts the load (AbortController) → "cancelled" + retry prompt.
 * - A rejected load (critical asset / manifest) → error + retry prompt.
 * Retrying = awaiting a single user event, converted into a promise.
 */
export async function runLoadingScreen(ctx, bounds, load) {
  const state = {
    phase: 'loading',
    done: 0,
    total: 0,
    current: '',
    failures: [],
    retries: 0,
    message: '',
  };

  let raf = requestAnimationFrame(function frame(now) {
    drawLoading(ctx, bounds, state, now / 1000);
    raf = requestAnimationFrame(frame);
  });

  try {
    for (;;) {
      const controller = new AbortController();
      const onKey = (e) => {
        if (e.code === 'Escape') controller.abort();
      };
      window.addEventListener('keydown', onKey);
      Object.assign(state, {
        phase: 'loading',
        done: 0,
        total: 0,
        failures: [],
        retries: 0,
        message: '',
      });

      try {
        const result = await load({
          signal: controller.signal,
          onProgress: ({ done, total, task, status, error }) => {
            state.done = done;
            state.total = total;
            if (task)
              state.current = `${status === 'retry' ? 'retrying' : status}: ${shortUrl(task.url)}`;
            if (status === 'retry') state.retries++;
            if (status === 'failed')
              state.failures.push(`${shortUrl(task.url)} — ${describeError(error)}`);
          },
        });
        state.phase = 'done';
        state.message = `loaded in ${result.ms} ms`;
        return result;
      } catch (err) {
        state.phase = err?.name === 'AbortError' ? 'cancelled' : 'error';
        state.message =
          state.phase === 'cancelled'
            ? 'Loading cancelled (Esc)'
            : `Loading failed: ${describeError(err)}`;
        if (state.phase === 'error') console.error('[loading]', err);
        else console.info('[loading] aborted by the user');
        await waitForRetry();
      } finally {
        window.removeEventListener('keydown', onKey);
      }
    }
  } finally {
    cancelAnimationFrame(raf);
  }
}

/** Promise from events: resolves on the first click / R / Enter, then removes both listeners. */
function waitForRetry() {
  const controller = new AbortController();
  return new Promise((resolve) => {
    const done = () => {
      controller.abort(); // removes every listener registered with this signal
      resolve();
    };
    window.addEventListener('pointerdown', done, { signal: controller.signal });
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.code === 'KeyR' || e.code === 'Enter') done();
      },
      { signal: controller.signal },
    );
  });
}

function drawLoading(ctx, { width, height }, s, time) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  ctx.fillStyle = NEON;
  ctx.font = 'bold 56px monospace';
  ctx.fillText('FLY OR DIE', width / 2, height / 2 - 110);

  const barW = 520;
  const barH = 22;
  const x = (width - barW) / 2;
  const y = height / 2 - 20;
  const ratio = s.total ? s.done / s.total : 0;
  ctx.strokeStyle = NEON;
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, barW, barH);
  ctx.fillStyle = s.phase === 'error' || s.phase === 'cancelled' ? '#ff4d4d' : NEON;
  ctx.fillRect(x + 3, y + 3, (barW - 6) * ratio, barH - 6);

  ctx.font = '16px monospace';
  ctx.fillStyle = '#ffffff';
  const pct = Math.round(ratio * 100);
  const dots = '.'.repeat(1 + (Math.floor(time * 3) % 3));
  const head =
    s.phase === 'loading'
      ? `Loading assets${dots}  ${s.done}/${s.total || '?'}  (${pct}%)`
      : s.phase === 'done'
        ? `Ready — ${s.message}`
        : s.message;
  ctx.fillText(head, width / 2, y + 52);

  ctx.font = '13px monospace';
  ctx.fillStyle = '#777';
  if (s.phase === 'loading') {
    ctx.fillText(s.current, width / 2, y + 76);
    ctx.fillText('Esc — cancel', width / 2, height - 30);
  }
  if (s.retries) {
    ctx.fillStyle = '#ffd23f';
    ctx.fillText(
      `${s.retries} retr${s.retries === 1 ? 'y' : 'ies'} with backoff`,
      width / 2,
      y + 98,
    );
  }
  s.failures.slice(-4).forEach((f, i) => {
    ctx.fillStyle = '#ff9a4d';
    ctx.fillText(`⚠ ${f}`, width / 2, y + 122 + i * 18);
  });

  if (s.phase === 'error' || s.phase === 'cancelled') {
    ctx.fillStyle = NEON;
    ctx.font = 'bold 20px monospace';
    const blink = Math.floor(time * 2) % 2 === 0;
    if (blink) ctx.fillText('[ click or press R to retry ]', width / 2, height - 80);
  }
}
