export function createInput(target) {
  const down = new Set();
  const pressedThisFrame = new Set();

  target.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    down.add(e.code);
    pressedThisFrame.add(e.code);
  });

  target.addEventListener('keyup', (e) => {
    down.delete(e.code);
  });

  return {
    isDown: (code) => down.has(code),
    justPressed: (code) => pressedThisFrame.has(code),
    consume: () => pressedThisFrame.clear()
  };
}