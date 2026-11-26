// Lobby DOM rendering. Listens to the Lobby's events; the Lobby never touches the DOM.
const NAME_KEY = 'flyordie.pilotName';
const TERRAIN = { classic: '🌲 fields', rocks: '🏜 desert', calm: '❄ snow' };

function loadName() {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}
function saveName(name) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* private mode etc. — not important */
  }
}

/**
 * Shows the lobby, wires it to `lobby`, resolves with { room, name } when the player joins.
 * `onGesture` is called synchronously inside the Join click (user gesture → audio unlock).
 */
export function showLobby(root, lobby, { notices = [], onGesture, error = null } = {}) {
  const ui = new AbortController(); // removes every listener below when we leave
  const { signal } = ui;
  const $ = (sel) => root.querySelector(sel);

  root.hidden = false;
  const nameInput = $('#pilot-name');
  const list = $('#room-list');
  const status = $('#lobby-status');
  const errorBox = $('#lobby-error');
  const noticeBox = $('#lobby-notices');

  nameInput.value = loadName() || `Pilot${Math.floor(Math.random() * 900 + 100)}`;
  noticeBox.replaceChildren(
    ...notices.map((n) => {
      const li = document.createElement('li');
      li.textContent = n;
      return li;
    }),
  );
  noticeBox.hidden = notices.length === 0;
  errorBox.hidden = !error;
  errorBox.textContent = error ?? '';

  // Online / offline badge + room creation (POST /api/rooms) — only with a server
  const serverBadge = $('#server-status');
  serverBadge.textContent = lobby.online
    ? '● online'
    : '○ offline — local game only (start the server for multiplayer)';
  serverBadge.className = lobby.online ? 'online' : 'offline';
  const createForm = $('#create-room');
  createForm.hidden = !lobby.online;
  createForm.addEventListener(
    'submit',
    async (e) => {
      e.preventDefault();
      const nameField = $('#new-room-name');
      const button = createForm.querySelector('button');
      button.disabled = true;
      try {
        const room = await lobby.createRoom({
          name: nameField.value,
          arena: $('#new-room-arena').value,
        });
        nameField.value = '';
        errorBox.hidden = true;
        updateStatus(`created "${room.name}"`);
      } catch (err) {
        errorBox.hidden = false;
        errorBox.textContent = `Could not create room: ${err.message}`;
      } finally {
        button.disabled = false;
      }
    },
    { signal },
  );

  // Rows are keyed by room id and UPDATED in place on every refresh. Re-creating them every 3 s
  // would swap the button under the cursor: a click whose mousedown and mouseup land on
  // different elements is lost (and keyboard focus would jump away).
  const rows = new Map(); // roomId -> <li>

  function createRow(room) {
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="room-main">
        <span class="room-name"></span>
        <span class="room-meta"></span>
      </div>
      <span class="room-players"></span>
      <button type="button"></button>`;
    li.querySelector('button').dataset.room = room.id;
    return li;
  }

  function updateRow(li, room) {
    const full = room.players >= room.maxPlayers;
    li.className = full ? 'room full' : 'room';
    // textContent, not innerHTML, for server data: a room name is not trusted HTML.
    li.querySelector('.room-name').textContent = room.name;
    li.querySelector('.room-meta').textContent =
      `${room.region?.toUpperCase() ?? ''} · ${TERRAIN[room.arena] ?? room.arena}`;
    li.querySelector('.room-players').textContent = `${room.players}/${room.maxPlayers}`;
    const btn = li.querySelector('button');
    btn.disabled = full;
    btn.textContent = full ? 'Full' : 'Join';
  }

  function renderRooms(rooms) {
    if (rooms.length === 0) {
      rows.clear();
      list.innerHTML = '<li class="empty">No rooms yet…</li>';
      return;
    }
    list.querySelector('li.empty')?.remove();
    const seen = new Set();
    rooms.forEach((room, i) => {
      seen.add(room.id);
      let li = rows.get(room.id);
      if (!li) rows.set(room.id, (li = createRow(room)));
      updateRow(li, room);
      if (list.children[i] !== li) list.insertBefore(li, list.children[i] ?? null); // keep order
    });
    for (const [id, li] of rows) {
      if (!seen.has(id)) {
        li.remove();
        rows.delete(id);
      }
    }
  }

  function updateStatus(text) {
    status.textContent = text;
  }

  lobby.addEventListener('loading', () => status.classList.add('busy'), { signal });
  lobby.addEventListener(
    'rooms',
    (e) => {
      status.classList.remove('busy');
      errorBox.hidden = true;
      renderRooms(e.detail.rooms);
      updateStatus(
        `updated ${new Date(lobby.lastUpdated).toLocaleTimeString()} · auto-refresh every ${lobby.intervalMs / 1000}s`,
      );
    },
    { signal },
  );
  lobby.addEventListener(
    'error',
    (e) => {
      status.classList.remove('busy');
      errorBox.hidden = false;
      errorBox.textContent = `Could not load rooms: ${e.detail.message}. Retrying automatically…`;
    },
    { signal },
  );

  list.addEventListener(
    'click',
    (e) => {
      const btn = e.target.closest('button[data-room]');
      if (!btn) return;
      onGesture?.(); // still inside the click handler = valid user gesture
      try {
        saveName(nameInput.value.trim());
        lobby.join(btn.dataset.room, nameInput.value);
      } catch (err) {
        errorBox.hidden = false;
        errorBox.textContent = err.message;
      }
    },
    { signal },
  );
  $('#lobby-refresh').addEventListener('click', () => lobby.refreshNow(), { signal });

  list.replaceChildren(); // rows from a previous visit belong to the previous `rows` map
  if (lobby.rooms.length) renderRooms(lobby.rooms);
  else list.innerHTML = '<li class="empty">Loading rooms…</li>';
  updateStatus('connecting…');
  lobby.start();

  return lobby.nextJoin().finally(() => {
    ui.abort();
    root.hidden = true;
  });
}
