FlyOrDie (Lab 1)

A top-down 2D arena game built with vanilla JavaScript, featuring a fixed-timestep simulation and interpolated rendering.

Lab 1 Deliverables
- **Fixed-timestep loop:** Physics runs strictly at 60 UPS.
- **Interpolated rendering:** Visuals scale to monitor refresh rate (e.g., 60/120/144 FPS) using alpha lerping.
- **Input closure:** Keyboard state is managed via a private `Set` closure, avoiding global variables.
- **Deterministic physics:** Simulation is decoupled from the DOM and rendering, ready for future multiplayer.

M4 Experiments & Measurements

1. The 100ms Busy-Wait
* **What happens:** The game stutters heavily. As measured in the HUD, the frame time spikes to ~97.40ms, and the render rate drops to 10 FPS, while the physics steps attempt to catch up (60 UPS) once the freeze ends.
* **Why:** JavaScript is single-threaded. The `while (performance.now() < t + 100)` block completely occupies the call stack. The event loop cannot process microtasks or trigger `requestAnimationFrame` for rendering until this synchronous loop finishes.

2. setInterval(frame, 16) vs requestAnimationFrame
* **What happens:** The render rate jitters (e.g., 63 FPS with ~15.60ms frame times) instead of locking to the monitor's native refresh rate. When switching to a background tab, `setInterval` continues to run in the background, whereas `requestAnimationFrame` pauses completely.
* **Why:** `setInterval` relies on the task queue and timer drift, ignoring the display's actual vsync. `requestAnimationFrame` is specifically designed to run right before the browser's paint step, ensuring smooth, tear-free animation and saving resources when the tab is inactive.

3. Variable Timestep + CPU Throttling
* **What happens:** Removing the accumulator and passing a varying `dt` directly into `simulate(dt)` breaks the fixed physics steps (dropping `steps/s` tracking to 0 while the game renders at 144 FPS / 7.00ms frame time). Under 6x CPU throttling, the ship's final position after 5 seconds of thrust differs significantly from its position under normal CPU loads.
* **Why:** Floating-point physics integration (Euler integration) is highly sensitive to step size. Large `dt` values (caused by throttling) compound mathematical errors differently than small `dt` values. Restoring the fixed-timestep (accumulator) ensures determinism: the physics engine always takes exact 1/60s steps, so identical inputs always produce identical final positions, regardless of the client's hardware speed.

---

FlyOrDie (Лабораторна 1)

2D-арена з виглядом зверху, створена на чистому JavaScript, із симуляцією з фіксованим кроком та інтерпольованим рендерингом.

Результати Лабораторної 1
- **Цикл із фіксованим кроком:** Фізика працює строго при 60 UPS.
- **Інтерпольований рендеринг:** Візуальна частина підлаштовується під частоту оновлення монітора за допомогою alpha-інтерполяції.
- **Замикання для інпуту:** Стан клавіатури керується через приватне замикання `Set`, уникаючи глобальних змінних.
- **Детермінована фізика:** Симуляція відокремлена від DOM та рендерингу для майбутнього мультиплеєра.

Експерименти та вимірювання M4

1. 100-мілісекундне зависання (Busy-Wait)
* **Що відбувається:** Гра сильно зависає. За даними HUD, час кадру підскакує до ~97.40ms, а частота кадрів падає до 10 FPS, тоді як фізика (60 UPS) намагається надолужити згаяне після розморозки.
* **Чому:** JavaScript є однопотоковим. Блок `while (performance.now() < t + 100)` повністю займає call stack. Event loop не може обробити мікрозадачі або викликати `requestAnimationFrame`, поки цей синхронний цикл не завершиться.

2. setInterval(frame, 16) vs requestAnimationFrame
* **Що відбувається:** Частота кадрів стрибає (наприклад, 63 FPS із часом кадру ~15.60ms) замість того, щоб зафіксуватися на 144 Гц монітора. На фоновій вкладці `setInterval` продовжує працювати, тоді як `requestAnimationFrame` ставиться на повну паузу.
* **Чому:** `setInterval` покладається на чергу задач і має зміщення таймера, ігноруючи реальний vsync. `requestAnimationFrame` спеціально розроблений для запуску перед кроком paint браузера, забезпечуючи плавну анімацію без розривів.

3. Змінний крок часу (Variable Timestep) + Тротлінг CPU
* **Що відбувається:** Видалення акумулятора ламає фіксовані кроки (лічильник `steps/s` падає до 0, хоча гра малює 144 FPS). При штучному уповільненні CPU у 6 разів кінцева позиція корабля після 5 секунд прискорення суттєво відрізняється від позиції без лагів.
* **Чому:** Фізична інтеграція (інтегрування Ейлера) дуже чутлива до розміру кроку. Великі значення `dt` (через тротлінг) накопичують математичні похибки інакше, ніж малі `dt`. Повернення акумулятора гарантує детермінованість: фізика завжди робить точні кроки по 1/60с, тому однакові вхідні дані дають однакову кінцеву позицію незалежно від потужності ПК.