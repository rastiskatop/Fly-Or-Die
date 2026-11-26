export function createInput(target) {
  const down = new Set();
  const pressedThisFrame = new Set();

  const editable = (el) =>
    el?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el?.tagName);

  target.addEventListener('keydown', (e) => {
    if (e.repeat || editable(e.target)) return; // typing in the chat/lobby isn't flying
    down.add(e.code);
    pressedThisFrame.add(e.code);
  });

  target.addEventListener('keyup', (e) => {
    down.delete(e.code);
  });

  return {
    isDown: (code) => down.has(code),
    justPressed: (code) => pressedThisFrame.has(code),
    consume: () => pressedThisFrame.clear(),
  };
}
