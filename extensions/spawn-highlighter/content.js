/**
 * OpenFront Spawn Highlighter
 * ----------------------------
 * Draws animated highlights over Nation and Tribe (bot) territories while
 * the spawn-point picker is active, so it's easier to see where the
 * pre-placed AI territories are before you click down a starting tile.
 *
 * How this hooks into the game
 * -----------------------------
 * OpenFront's client doesn't expose a global debug API, so this script runs
 * in the page's own JS world (see "world": "MAIN" in manifest.json) and
 * reads the same live objects the game's own UI components use.
 *
 * `createRenderer()` (src/client/hud/GameRenderer.ts) sets two properties
 * directly on the `<player-info-overlay>` custom element once a match
 * starts rendering:
 *   playerInfo.transform = transformHandler;  // camera pan/zoom + coord math
 *   playerInfo.game       = game;             // GameView, the client's read
 *                                              // model of the whole match
 *
 * Both are otherwise-internal instances, not part of any documented API, so
 * this script is inherently coupled to that element existing with those two
 * properties. If OpenFront refactors GameRenderer this will need updating —
 * see the repo README for how to re-diagnose that.
 *
 * We only ever call public-looking read methods on them
 * (GameView#inSpawnPhase/playerViews, PlayerView#type/isAlive/nameLocation,
 * TransformHandler#worldToScreenCoordinates) — nothing here mutates game
 * state or touches the network/worker layer.
 */
(() => {
  const ANCHOR_SELECTOR = "player-info-overlay";

  const STYLE = {
    NATION: {
      ring: [255, 201, 74], // gold
      label: "Nation",
      badge: "✦",
    },
    BOT: {
      ring: [72, 229, 255], // cyan
      label: "Tribe",
      badge: "▲",
    },
  };

  const PULSE_PERIOD_MS = 2200;
  const RING_COUNT = 2; // concentric rings, phase-offset, radar-ping style
  const MIN_WORLD_RADIUS = 6;
  const MAX_WORLD_RADIUS = 26;
  const FADE_MS = 350;

  let canvas = null;
  let ctx = null;
  let legendEl = null;
  let dpr = window.devicePixelRatio || 1;

  let currentGame = null;
  let currentTransform = null;
  let rafHandle = null;

  // Visibility is user-toggleable (Alt+H) independent of spawn phase, so a
  // player who doesn't want the overlay can turn it off for the session.
  let userEnabled = true;

  // Fade state: 0 = fully hidden, 1 = fully shown. Tracks toward `target`
  // every frame so entering/leaving spawn phase doesn't hard-cut.
  let opacity = 0;

  function findAnchor() {
    const el = document.querySelector(ANCHOR_SELECTOR);
    if (el && el.game && el.transform) return el;
    return null;
  }

  function ensureCanvas() {
    if (canvas && document.body.contains(canvas)) return;
    canvas = document.createElement("canvas");
    canvas.id = "ofio-spawn-highlighter-canvas";
    Object.assign(canvas.style, {
      position: "fixed",
      inset: "0",
      width: "100vw",
      height: "100vh",
      pointerEvents: "none",
      zIndex: "40", // above the game canvas/input overlay, below modals
    });
    document.body.appendChild(canvas);
    ctx = canvas.getContext("2d");

    legendEl = document.createElement("div");
    legendEl.id = "ofio-spawn-highlighter-legend";
    Object.assign(legendEl.style, {
      position: "fixed",
      left: "12px",
      bottom: "12px",
      display: "flex",
      flexDirection: "column",
      gap: "4px",
      padding: "6px 10px",
      borderRadius: "8px",
      background: "rgba(15, 17, 26, 0.55)",
      backdropFilter: "blur(2px)",
      font: "600 12px/1.3 system-ui, sans-serif",
      color: "#fff",
      pointerEvents: "none",
      zIndex: "40",
      transition: "opacity 150ms linear",
    });
    legendEl.innerHTML = [
      legendRow(STYLE.NATION, "Nation"),
      legendRow(STYLE.BOT, "Tribe"),
    ].join("");
    document.body.appendChild(legendEl);

    window.addEventListener("resize", resizeCanvas, { passive: true });
    resizeCanvas();
  }

  function legendRow(style, text) {
    const [r, g, b] = style.ring;
    return (
      `<span style="display:flex;align-items:center;gap:6px;">` +
      `<span style="color:rgb(${r},${g},${b});">${style.badge}</span>${text}` +
      `</span>`
    );
  }

  function resizeCanvas() {
    if (!canvas) return;
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
  }

  function pulsePhase(now, offset) {
    return (
      ((now + offset * PULSE_PERIOD_MS) % PULSE_PERIOD_MS) / PULSE_PERIOD_MS
    );
  }

  function drawHighlight(px, py, worldRadius, scale, style, now, seed) {
    const baseRadius = Math.max(4, worldRadius * scale);
    const [r, g, b] = style.ring;

    for (let i = 0; i < RING_COUNT; i++) {
      const phase = pulsePhase(now + seed, i / RING_COUNT);
      // Ease-out expansion, fading as it grows — a soft radar ping.
      const grow = 1 - Math.pow(1 - phase, 2);
      const radius = baseRadius * (0.55 + 0.85 * grow);
      const alpha = (1 - phase) * 0.6;

      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(1.2, baseRadius * 0.05);
      ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
      ctx.stroke();
    }

    // Soft glow disc, gently breathing, anchors the pulsing rings to a
    // steady location so the highlight reads at a glance.
    const breathe = 0.5 + 0.5 * Math.sin((now + seed) / 480);
    const glowRadius = baseRadius * (0.9 + 0.15 * breathe);
    const gradient = ctx.createRadialGradient(
      px,
      py,
      0,
      px,
      py,
      glowRadius,
    );
    gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${0.28 + 0.1 * breathe})`);
    gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(px, py, glowRadius, 0, Math.PI * 2);
    ctx.fill();

    // Solid core dot.
    ctx.beginPath();
    ctx.arc(px, py, Math.max(1.5, baseRadius * 0.12), 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.95)`;
    ctx.fill();
  }

  function draw(now) {
    rafHandle = requestAnimationFrame(draw);

    const anchor = findAnchor();
    if (!anchor) {
      currentGame = null;
      currentTransform = null;
      if (canvas) canvas.style.display = "none";
      if (legendEl) legendEl.style.display = "none";
      return;
    }
    currentGame = anchor.game;
    currentTransform = anchor.transform;

    ensureCanvas();

    const wantVisible =
      userEnabled && !!currentGame.inSpawnPhase && currentGame.inSpawnPhase();
    const target = wantVisible ? 1 : 0;
    const step = 16 / FADE_MS; // ~1 frame at 60fps worth of fade
    opacity += Math.sign(target - opacity) * Math.min(step, Math.abs(target - opacity));

    if (opacity <= 0.001) {
      canvas.style.display = "none";
      legendEl.style.display = "none";
      return;
    }

    canvas.style.display = "block";
    legendEl.style.display = "flex";
    legendEl.style.opacity = String(opacity);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    ctx.globalAlpha = opacity;

    const scale = currentTransform.scale ?? 1;
    let players = [];
    try {
      players = currentGame.playerViews();
    } catch {
      players = [];
    }

    for (const pv of players) {
      let type;
      try {
        type = pv.type();
      } catch {
        continue;
      }
      const style = STYLE[type];
      if (!style) continue;
      if (typeof pv.isAlive === "function" && !pv.isAlive()) continue;

      let loc;
      try {
        loc = pv.nameLocation && pv.nameLocation();
      } catch {
        loc = undefined;
      }
      if (!loc || (loc.x === 0 && loc.y === 0 && loc.size === 0)) continue;

      let screen;
      try {
        screen = currentTransform.worldToScreenCoordinates({
          x: loc.x,
          y: loc.y,
        });
      } catch {
        continue;
      }
      if (
        screen.x < -50 ||
        screen.y < -50 ||
        screen.x > window.innerWidth + 50 ||
        screen.y > window.innerHeight + 50
      ) {
        continue; // off-screen, skip the draw call
      }

      const worldRadius = Math.min(
        MAX_WORLD_RADIUS,
        Math.max(MIN_WORLD_RADIUS, (loc.size ?? 10) * 1.4),
      );

      // Stable per-player animation offset so highlights don't all pulse in
      // lockstep — derived from a cheap string hash of the player id.
      let seed = 0;
      const id = (typeof pv.id === "function" && pv.id()) || style.label;
      for (let i = 0; i < id.length; i++) {
        seed = (seed * 31 + id.charCodeAt(i)) % PULSE_PERIOD_MS;
      }

      drawHighlight(screen.x, screen.y, worldRadius, scale, style, now, seed);
    }

    ctx.globalAlpha = 1;
  }

  function onKeydown(e) {
    if (!e.altKey || e.key.toLowerCase() !== "h") return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    userEnabled = !userEnabled;
  }

  function start() {
    window.addEventListener("keydown", onKeydown);
    rafHandle = requestAnimationFrame(draw);
  }

  start();
})();
