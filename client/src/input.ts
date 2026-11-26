export interface Input {
  isDown(code: string): boolean;
  justPressed(code: string): boolean;
  consume(): void;
}

/** `KeyboardEvent.code` values held down, kept private in a closure (Lab 1). */
export function createInput(target: Window): Input {
  const down = new Set<string>();
  const pressedThisFrame = new Set<string>();

  // e.target is an EventTarget | null: narrow with instanceof, not a cast.
  const editable = (el: EventTarget | null): boolean =>
    el instanceof HTMLElement &&
    (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

  target.addEventListener('keydown', (e) => {
    if (e.repeat || editable(e.target)) return; // typing in the chat/lobby isn't flying
    down.add(e.code);
    pressedThisFrame.add(e.code);
  });

  target.addEventListener('keyup', (e) => {
    down.delete(e.code);
  });

  return {
    isDown: (code: string) => down.has(code),
    justPressed: (code: string) => pressedThisFrame.has(code),
    consume: () => pressedThisFrame.clear(),
  };
}
