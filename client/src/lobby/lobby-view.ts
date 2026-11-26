// Lobby DOM rendering. Listens to the Lobby's events; the Lobby never touches the DOM.
import type { Lobby, LobbyEvents } from './lobby.ts';
import type { RoomInfo } from '@flyordie/shared/net/messages.ts';

/**
 * querySelector + runtime type check: `el(root, '#pilot-name', HTMLInputElement)` returns an
 * HTMLInputElement or throws — no `as HTMLInputElement` cast that would lie if the markup changed.
 */
export function el<T extends Element>(
  root: ParentNode,
  selector: string,
  type: { new (): T; prototype: T },
): T {
  const found = root.querySelector(selector);
  if (!(found instanceof type)) throw new Error(`${selector}: expected ${type.name}`);
  return found;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const NAME_KEY = 'flyordie.pilotName';
const TERRAIN: Readonly<Record<string, string>> = {
  classic: '🌲 fields',
  rocks: '🏜 desert',
  calm: '❄ snow',
};

function loadName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}
function saveName(name: string): void {
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
export function showLobby(
  root: HTMLElement,
  lobby: Lobby,
  {
    notices = [],
    onGesture,
    error = null,
  }: { notices?: readonly string[]; onGesture?: () => void; error?: string | null } = {},
): Promise<LobbyEvents['join']> {
  const ui = new AbortController(); // removes every listener below when we leave
  const { signal } = ui;

  root.hidden = false;
  const nameInput = el(root, '#pilot-name', HTMLInputElement);
  const list = el(root, '#room-list', HTMLUListElement);
  const status = el(root, '#lobby-status', HTMLDivElement);
  const errorBox = el(root, '#lobby-error', HTMLDivElement);
  const noticeBox = el(root, '#lobby-notices', HTMLUListElement);

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
  const serverBadge = el(root, '#server-status', HTMLSpanElement);
  serverBadge.textContent = lobby.online
    ? '● online'
    : '○ offline — local game only (start the server for multiplayer)';
  serverBadge.className = lobby.online ? 'online' : 'offline';
  const createForm = el(root, '#create-room', HTMLFormElement);
  createForm.hidden = !lobby.online;
  // addEventListener ignores what a listener returns: an async listener's promise would float.
  // createRoom catches everything itself, and `void` marks the fire-and-forget on purpose.
  createForm.addEventListener('submit', (e) => void createRoom(e), { signal });

  async function createRoom(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    const nameField = el(createForm, '#new-room-name', HTMLInputElement);
    const button = el(createForm, 'button', HTMLButtonElement);
    button.disabled = true;
    try {
      const room = await lobby.createRoom({
        name: nameField.value,
        arena: el(createForm, '#new-room-arena', HTMLSelectElement).value,
      });
      nameField.value = '';
      errorBox.hidden = true;
      updateStatus(`created "${room.name}"`);
    } catch (err: unknown) {
      errorBox.hidden = false;
      errorBox.textContent = `Could not create room: ${message(err)}`;
    } finally {
      button.disabled = false;
    }
  }

  // Rows are keyed by room id and UPDATED in place on every refresh. Re-creating them every 3 s
  // would swap the button under the cursor: a click whose mousedown and mouseup land on
  // different elements is lost (and keyboard focus would jump away).
  const rows = new Map<string, HTMLLIElement>(); // roomId -> <li>

  function createRow(room: RoomInfo): HTMLLIElement {
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="room-main">
        <span class="room-name"></span>
        <span class="room-meta"></span>
      </div>
      <span class="room-players"></span>
      <button type="button"></button>`;
    el(li, 'button', HTMLButtonElement).dataset.room = room.id;
    return li;
  }

  function updateRow(li: HTMLLIElement, room: RoomInfo): void {
    const full = room.players >= room.maxPlayers;
    li.className = full ? 'room full' : 'room';
    // textContent, not innerHTML, for server data: a room name is not trusted HTML.
    el(li, '.room-name', HTMLSpanElement).textContent = room.name;
    el(li, '.room-meta', HTMLSpanElement).textContent =
      `${room.region.toUpperCase()} · ${TERRAIN[room.arena] ?? room.arena}`;
    el(li, '.room-players', HTMLSpanElement).textContent = `${room.players}/${room.maxPlayers}`;
    const btn = el(li, 'button', HTMLButtonElement);
    btn.disabled = full;
    btn.textContent = full ? 'Full' : 'Join';
  }

  function renderRooms(rooms: readonly RoomInfo[]): void {
    if (rooms.length === 0) {
      rows.clear();
      list.innerHTML = '<li class="empty">No rooms yet…</li>';
      return;
    }
    list.querySelector('li.empty')?.remove();
    const seen = new Set<string>();
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

  function updateStatus(text: string): void {
    status.textContent = text;
  }

  lobby.on('loading', () => status.classList.add('busy'), { signal });
  lobby.on(
    'rooms',
    ({ rooms }) => {
      status.classList.remove('busy');
      errorBox.hidden = true;
      renderRooms(rooms);
      updateStatus(
        `updated ${new Date(lobby.lastUpdated ?? Date.now()).toLocaleTimeString()} · auto-refresh every ${lobby.intervalMs / 1000}s`,
      );
    },
    { signal },
  );
  lobby.on(
    'error',
    ({ message: why }) => {
      status.classList.remove('busy');
      errorBox.hidden = false;
      errorBox.textContent = `Could not load rooms: ${why}. Retrying automatically…`;
    },
    { signal },
  );

  list.addEventListener(
    'click',
    (e) => {
      const btn = e.target instanceof Element ? e.target.closest('button[data-room]') : null;
      if (!(btn instanceof HTMLButtonElement) || !btn.dataset.room) return;
      onGesture?.(); // still inside the click handler = valid user gesture
      try {
        saveName(nameInput.value.trim());
        lobby.join(btn.dataset.room, nameInput.value);
      } catch (err: unknown) {
        errorBox.hidden = false;
        errorBox.textContent = message(err);
      }
    },
    { signal },
  );
  el(root, '#lobby-refresh', HTMLButtonElement).addEventListener(
    'click',
    () => void lobby.refreshNow(),
    { signal },
  );

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
