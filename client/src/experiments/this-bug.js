// Live demonstration of the `this` bug for the Lab 2 defense.
// Open the game with ?demo=this and look at the console.
export function demonstrateThisBug(ship, world) {
  console.group('[Lab 2] the `this` bug: passing ship.fire as a callback');

  // BUG: we pass the function, not the call. The timer later calls it as a bare
  // function: fire() — default binding, `this` is undefined (modules are strict).
  setTimeout(function naive() {
    const fire = ship.fire; // what setTimeout(ship.fire, 0) effectively does
    try {
      fire(world);
    } catch (err) {
      console.error('naive   setTimeout(ship.fire):', err.message);
    }
  }, 0);

  // FIX 1: arrow wrapper — the call `ship.fire(world)` happens with ship left of the dot.
  setTimeout(() => {
    const b = ship.fire(world);
    console.log('fix 1   () => ship.fire(world)      -> bullet', b?.id);
  }, 10);

  // FIX 2: bind — a new function permanently bound to ship.
  setTimeout(() => {
    const bound = ship.fire.bind(ship);
    const b = bound(world);
    console.log('fix 2   ship.fire.bind(ship)        -> bullet', b?.id);
  }, 20);

  // FIX 3 (not used in the game): class-field arrow `fire = (world) => {...}`
  // — captures `this` per instance, costs one closure per ship.
  setTimeout(() => {
    class ArrowShip {
      name = 'arrow-ship';
      fire = () => this.name;
    }
    const s = new ArrowShip();
    const detached = s.fire;
    console.log('fix 3   class field arrow           ->', detached());
    console.log(
      '        own property? ',
      Object.hasOwn(s, 'fire'),
      '| on prototype? ',
      'fire' in ArrowShip.prototype,
    );
    console.groupEnd();
  }, 30);
}
