// In-match chat + roster panel. Renders what the Connection dispatches; sends via the Connection.
const MAX_LINES = 60;

export function showChat(root, conn, { selfId, signal }) {
  const $ = (sel) => root.querySelector(sel);
  const roster = $('#chat-roster');
  const logEl = $('#chat-log');
  const input = $('#chat-input');
  const status = $('#chat-status');
  root.hidden = false;
  // Pin the panel to the canvas' bottom-right corner (above the controls hint), whatever the window size.
  const place = () => {
    const r = document.getElementById('gameCanvas').getBoundingClientRect();
    root.style.right = `${Math.max(8, window.innerWidth - r.right + 12)}px`;
    root.style.bottom = `${Math.max(8, window.innerHeight - r.bottom + 36)}px`;
  };
  place();
  window.addEventListener('resize', place, { signal });
  logEl.replaceChildren();
  roster.textContent = '';
  status.textContent = '';

  const on = (type, fn) => conn.addEventListener(type, (e) => fn(e.detail), { signal });

  function line(cls, parts) {
    const li = document.createElement('li');
    li.className = cls;
    for (const [text, partCls] of parts) {
      const span = document.createElement('span');
      if (partCls) span.className = partCls;
      span.textContent = text; // text, never HTML: chat comes from other players
      li.append(span);
    }
    logEl.append(li);
    while (logEl.children.length > MAX_LINES) logEl.firstChild.remove();
    logEl.scrollTop = logEl.scrollHeight;
  }

  on('roster', ({ players }) => {
    roster.replaceChildren(
      ...players.map((p) => {
        const span = document.createElement('span');
        span.className = p.id === selfId() ? 'me' : '';
        span.textContent = p.name;
        return span;
      }),
    );
  });
  on('chat', ({ from, text }) =>
    line('msg', [
      [`${from.name}: `, from.id === selfId() ? 'who me' : 'who'],
      [text, ''],
    ]),
  );
  on('system', ({ text }) => line('sys', [[text, '']]));
  on('status', ({ state, attempt, delayMs, code }) => {
    status.className = state === 'open' ? '' : 'warn';
    status.textContent =
      state === 'open'
        ? ''
        : state === 'waiting'
          ? `connection lost (${code}) — reconnecting in ${(delayMs / 1000).toFixed(1)}s (try ${attempt})`
          : state === 'closed'
            ? `disconnected (${code ?? ''})`
            : `${state}…`;
    if (conn.queued && state !== 'open') status.textContent += ` · ${conn.queued} queued`;
  });

  // Typing must not fly the plane: input.js ignores keydowns from editable elements.
  // Keyups still go through, so a key held while focusing the chat is released properly.
  input.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Enter') {
        e.stopPropagation(); // otherwise the window handler below would re-focus the input
        const text = input.value.trim();
        if (text) conn.send({ type: 'chat', text: text.slice(0, 200) });
        input.value = '';
        input.blur();
      } else if (e.key === 'Escape') {
        e.stopPropagation(); // Esc in the chat only leaves the chat, not the match
        input.blur();
      }
    },
    { signal },
  );
  // Enter (or T) while flying focuses the chat input.
  window.addEventListener(
    'keydown',
    (e) => {
      if ((e.key === 'Enter' || e.code === 'KeyT') && document.activeElement !== input) {
        e.preventDefault();
        input.focus();
      }
    },
    { signal },
  );
  signal.addEventListener('abort', () => {
    root.hidden = true;
    input.blur();
  });
}
