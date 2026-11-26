import { describeError } from '../assets/net.js';
import { shortUrl } from '../assets/base.js';

// Military palette: khaki text on an olive panel, amber progress.
const KHAKI = '#e8dcb5';
const AMBER = '#f0a330';
const TITLE_FONT = "'Black Ops One', 'Russo One', Impact, sans-serif";
const UI_FONT = "'Russo One', 'Segoe UI', sans-serif";

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
  // Transparent canvas: the animated war backdrop (menu-bg.js) shows through.
  ctx.clearRect(0, 0, width, height);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  // Olive panel with a hazard-striped top edge
  const pw = 640;
  const ph = 300;
  const px = (width - pw) / 2;
  const py = height / 2 - 170;
  ctx.fillStyle = 'rgba(38, 44, 26, 0.88)';
  ctx.fillRect(px, py, pw, ph);
  ctx.save();
  ctx.beginPath();
  ctx.rect(px, py, pw, 10);
  ctx.clip();
  for (let x = px - 20; x < px + pw + 20; x += 24) {
    ctx.fillStyle = '#d9a520';
    ctx.beginPath();
    ctx.moveTo(x, py + 10);
    ctx.lineTo(x + 12, py);
    ctx.lineTo(x + 24, py);
    ctx.lineTo(x + 12, py + 10);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  ctx.strokeStyle = 'rgba(200, 185, 140, 0.5)';
  ctx.lineWidth = 2;
  ctx.strokeRect(px, py, pw, ph);

  ctx.fillStyle = KHAKI;
  ctx.font = `64px ${TITLE_FONT}`;
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowOffsetY = 3;
  ctx.fillText('FLY OR DIE', width / 2, py + 95);
  ctx.shadowColor = 'transparent';
  ctx.font = `14px ${UI_FONT}`;
  ctx.fillStyle = 'rgba(232, 220, 181, 0.6)';
  ctx.fillText('— AIR COMBAT —', width / 2, py + 122);

  const barW = 520;
  const barH = 22;
  const x = (width - barW) / 2;
  const y = py + 150;
  const ratio = s.total ? s.done / s.total : 0;
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(x, y, barW, barH);
  ctx.strokeStyle = KHAKI;
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, barW, barH);
  ctx.fillStyle = s.phase === 'error' || s.phase === 'cancelled' ? '#c8432f' : AMBER;
  ctx.fillRect(x + 3, y + 3, (barW - 6) * ratio, barH - 6);

  ctx.font = `16px ${UI_FONT}`;
  ctx.fillStyle = '#ffffff';
  const pct = Math.round(ratio * 100);
  const dots = '.'.repeat(1 + (Math.floor(time * 3) % 3));
  const head =
    s.phase === 'loading'
      ? `Loading ammo${dots}  ${s.done}/${s.total || '?'}  (${pct}%)`
      : s.phase === 'done'
        ? `Ready — ${s.message}`
        : s.message;
  ctx.fillText(head, width / 2, y + 50);

  ctx.font = '12px monospace';
  ctx.fillStyle = 'rgba(232, 220, 181, 0.55)';
  if (s.phase === 'loading') {
    ctx.fillText(s.current, width / 2, y + 74);
    ctx.fillText('Esc — cancel', width / 2, py + ph - 14);
  }
  if (s.retries) {
    ctx.fillStyle = '#ffd23f';
    ctx.fillText(
      `${s.retries} retr${s.retries === 1 ? 'y' : 'ies'} with backoff`,
      width / 2,
      y + 94,
    );
  }
  s.failures.slice(-4).forEach((f, i) => {
    ctx.fillStyle = '#ffb066';
    ctx.fillText(`⚠ ${f}`, width / 2, py + ph + 24 + i * 18);
  });

  if (s.phase === 'error' || s.phase === 'cancelled') {
    ctx.fillStyle = AMBER;
    ctx.font = `20px ${UI_FONT}`;
    const blink = Math.floor(time * 2) % 2 === 0;
    if (blink) ctx.fillText('[ click or press R to retry ]', width / 2, py + ph - 14);
  }
}
