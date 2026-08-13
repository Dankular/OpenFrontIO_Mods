/**
 * OpenFront Attack Radar
 * -----------------------
 * Predicts when each Nation/Tribe bot will next re-evaluate whether to
 * attack, and takes a best-effort guess at who it'll go for — surfaced as
 * a "next decisions" panel plus animated cooldown/danger highlights on the
 * map.
 *
 * Same hook as the spawn-highlighter extension in this collection: runs in
 * the page's own JS world ("world": "MAIN") and reads the GameView /
 * TransformHandler instances the game itself stashes on the
 * <player-info-overlay> element. See that extension's README for the full
 * writeup of that technique — this file only repeats what's specific to
 * prediction below.
 *
 * ── Why "when" is exact but "who" is a guess ──────────────────────────
 * OpenFront's bot AI (src/core/execution/{TribeExecution,NationExecution}.ts)
 * only re-evaluates whether to attack on ticks where
 * `ticks % attackRate === attackTick`. Both numbers are drawn from a
 * PseudoRandom seeded once, deterministically, from the bot's player ID
 * (and, for Nations, the game ID + configured difficulty) — nothing about
 * them depends on how the match plays out. So `attackRate`/`attackTick`
 * reimplemented here from a player's public `.id()` land on the *exact*
 * same values the real simulation computed, and the "next decision in Ns"
 * countdown is fully deterministic, not a guess.
 *
 * `simpleHash()` and `PseudoRandom` below are an independent
 * reimplementation of core/Util.ts's simpleHash and core/PseudoRandom.ts's
 * sfc32-based generator — well-known, small, and fully specified
 * algorithms, reproduced here (not copied from OpenFront's source) because
 * bit-exact output is what makes the countdown reliable at all.
 *
 * Who they attack, on the other hand, comes out of a long, heavily
 * randomized decision tree (see AiAttackBehavior.ts) that also depends on
 * real border-tile adjacency — data the client doesn't cheaply expose
 * (PlayerView has no `nearby()`/`borderTiles()` sync accessor; the async
 * one round-trips to a worker and isn't something we want to hammer for
 * every bot every second). So the "likely target" guess here is a
 * heuristic — real signals where we have them (an existing incoming
 * attack, disconnected/AFK status, traitor status), falling back to
 * "weakest territory within plausible reach" using name-label distance as
 * a stand-in for a real border check. Treat it as informed guesswork, not
 * a spoiler.
 */
(() => {
  const ANCHOR_SELECTOR = "player-info-overlay";
  const TICK_MS = 100; // core/GameRunner turn interval — 10 ticks/sec

  // ── Deterministic reimplementation of core/Util.ts#simpleHash ─────────
  function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash = hash & hash;
    }
    return Math.abs(hash);
  }

  // ── Deterministic reimplementation of core/PseudoRandom.ts (sfc32) ────
  class PseudoRandom {
    constructor(seed) {
      let h = seed | 0;
      const split = () => {
        h = (h + 0x9e3779b9) | 0;
        let t = h ^ (h >>> 16);
        t = Math.imul(t, 0x21f0aaad);
        t = t ^ (t >>> 15);
        t = Math.imul(t, 0x735a2d97);
        return (t ^ (t >>> 15)) | 0;
      };
      this.s0 = split();
      this.s1 = split();
      this.s2 = split();
      this.s3 = split();
      for (let i = 0; i < 12; i++) this.next();
    }
    next() {
      const t = (((this.s0 + this.s1) | 0) + this.s3) | 0;
      this.s3 = (this.s3 + 1) | 0;
      this.s0 = this.s1 ^ (this.s1 >>> 9);
      this.s1 = (this.s2 + (this.s2 << 3)) | 0;
      this.s2 = (this.s2 << 21) | (this.s2 >>> 11);
      this.s2 = (this.s2 + t) | 0;
      return (t >>> 0) / 4294967296;
    }
    nextInt(min, max) {
      const lo = Math.floor(min);
      const hi = Math.floor(max);
      return Math.floor(this.next() * (hi - lo)) + lo;
    }
  }

  // Matches NationExecution#getAttackRate's difficulty switch exactly.
  const NATION_ATTACK_RATE_RANGE = {
    Easy: [65, 100],
    Medium: [55, 70],
    Hard: [45, 60],
    Impossible: [30, 50],
  };

  // How close (in ticks) a decision has to be before we draw the cooldown
  // ring / danger ring / connecting line on the map, instead of only
  // listing it in the panel.
  const DANGER_TICKS = 30; // 3s
  // Board panel always lists this many upcoming decisions, regardless of
  // how far out they are.
  const TOP_N = 6;
  // Re-walk the player list and rebuild the board this often. The canvas
  // still redraws every animation frame using the cached board.
  const RECOMPUTE_MS = 350;
  // World-unit slack added to two territories' name-label sizes when
  // deciding whether they're "close enough" to plausibly border each
  // other. name-label size is a rough proxy for territory footprint, not
  // a real radius — see the file header.
  const PROXIMITY_MARGIN = 35;

  const CONFIDENCE_STYLE = {
    high: { color: [255, 80, 80], label: "likely" }, // retaliation
    medium: { color: [255, 150, 60], label: "possible" }, // afk / traitor
    low: { color: [255, 210, 90], label: "guess" }, // weakest nearby
  };
  const ATTACKER_COLOR = [255, 201, 74]; // amber, matches the collection's Nation accent

  let canvas = null;
  let ctx = null;
  let panelEl = null;
  let dpr = window.devicePixelRatio || 1;

  let currentGame = null;
  let currentTransform = null;
  let paramsCache = new Map(); // playerId -> { attackRate, attackTick, triggerRatio, reserveRatio, expandRatio }
  let board = []; // sorted ascending by ticksLeft, see recomputeBoard()
  let lastRecompute = 0;

  let userEnabled = true;
  let opacity = 0;
  const FADE_MS = 350;

  function findAnchor() {
    const el = document.querySelector(ANCHOR_SELECTOR);
    if (el && el.game && el.transform) return el;
    return null;
  }

  function paramsFor(pv, game) {
    const id = pv.id();
    const cached = paramsCache.get(id);
    if (cached) return cached;

    const type = pv.type();
    let params = null;
    if (type === "BOT") {
      // Mirrors TribeExecution's constructor draw order exactly.
      const rnd = new PseudoRandom(simpleHash(id));
      const attackRate = rnd.nextInt(40, 80);
      const attackTick = rnd.nextInt(0, attackRate);
      const triggerRatio = rnd.nextInt(50, 60) / 100;
      const reserveRatio = rnd.nextInt(30, 40) / 100;
      const expandRatio = rnd.nextInt(10, 20) / 100;
      params = { attackRate, attackTick, triggerRatio, reserveRatio, expandRatio };
    } else if (type === "NATION") {
      // Mirrors NationExecution's constructor + init() draw order exactly.
      let gameID = "";
      try {
        gameID = game.gameID();
      } catch {
        gameID = "";
      }
      const seed = simpleHash(id) + simpleHash(gameID);
      const rnd = new PseudoRandom(seed);
      const triggerRatio = rnd.nextInt(50, 60) / 100;
      const reserveRatio = rnd.nextInt(30, 40) / 100;
      const expandRatio = rnd.nextInt(10, 20) / 100;
      let difficulty = "Medium";
      try {
        difficulty = game.config().gameConfig().difficulty;
      } catch {
        difficulty = "Medium";
      }
      const range = NATION_ATTACK_RATE_RANGE[difficulty] ?? [55, 70];
      const attackRate = rnd.nextInt(range[0], range[1]);
      const attackTick = rnd.nextInt(0, attackRate);
      params = { attackRate, attackTick, triggerRatio, reserveRatio, expandRatio };
    }

    if (params) paramsCache.set(id, params);
    return params;
  }

  function ticksUntilNextDecision(params, currentTick) {
    const mod = currentTick % params.attackRate;
    let delta = params.attackTick - mod;
    if (delta < 0) delta += params.attackRate;
    return delta;
  }

  function readiness(pv, game, params) {
    let maxTroops;
    try {
      maxTroops = game.config().maxTroops(pv);
    } catch {
      return null;
    }
    if (!maxTroops || maxTroops <= 0) return null;
    const ratio = pv.troops() / maxTroops;
    return {
      ratio,
      meetsReserve: ratio >= params.reserveRatio,
      meetsTrigger: ratio >= params.triggerRatio,
    };
  }

  /** Best-effort guess at who a bot will target next. See file header. */
  function guessVictim(pv, game, allPlayers) {
    // Real signal: currently under attack -> likely retaliates against the
    // biggest attacker (mirrors findIncomingAttackPlayer, used by both the
    // tribe and nation decision paths).
    let incoming = [];
    try {
      incoming = pv.incomingAttacks();
    } catch {
      incoming = [];
    }
    if (incoming.length > 0) {
      let biggest = incoming[0];
      for (const a of incoming) if (a.troops > biggest.troops) biggest = a;
      try {
        const attacker = game.playerBySmallID(biggest.attackerID);
        if (attacker && attacker.isPlayer && attacker.isPlayer()) {
          return { target: attacker, confidence: "high", reason: "retaliating" };
        }
      } catch {
        // fall through to proximity guess
      }
    }

    const loc = pv.nameLocation && pv.nameLocation();
    if (!loc) return null;

    const candidates = [];
    for (const other of allPlayers) {
      if (other === pv) continue;
      if (!other.isAlive()) continue;
      let friendly = false;
      try {
        friendly = pv.isFriendly(other);
      } catch {
        friendly = false;
      }
      if (friendly) continue;
      const oloc = other.nameLocation && other.nameLocation();
      if (!oloc) continue;
      const dx = oloc.x - loc.x;
      const dy = oloc.y - loc.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const reach = (loc.size || 10) + (oloc.size || 10) + PROXIMITY_MARGIN;
      if (dist > reach) continue;
      candidates.push(other);
    }
    if (candidates.length === 0) return null;

    const afk = candidates.find((c) => {
      try {
        return c.isDisconnected();
      } catch {
        return false;
      }
    });
    if (afk) return { target: afk, confidence: "medium", reason: "AFK neighbor" };

    const traitor = candidates.find((c) => {
      try {
        return c.isTraitor();
      } catch {
        return false;
      }
    });
    if (traitor) return { target: traitor, confidence: "medium", reason: "traitor" };

    candidates.sort((a, b) => a.troops() - b.troops());
    return { target: candidates[0], confidence: "low", reason: "weakest nearby" };
  }

  function recomputeBoard(game) {
    let players = [];
    try {
      players = game.players();
    } catch {
      players = [];
    }
    const currentTick = (() => {
      try {
        return game.ticks();
      } catch {
        return 0;
      }
    })();

    const entries = [];
    for (const pv of players) {
      let type;
      try {
        type = pv.type();
      } catch {
        continue;
      }
      if (type !== "BOT" && type !== "NATION") continue;
      if (!pv.isAlive()) continue;
      const params = paramsFor(pv, game);
      if (!params) continue;
      const ticksLeft = ticksUntilNextDecision(params, currentTick);
      entries.push({ pv, params, ticksLeft });
    }

    entries.sort((a, b) => a.ticksLeft - b.ticksLeft);
    const top = entries.slice(0, TOP_N);

    for (const entry of top) {
      entry.readiness = readiness(entry.pv, game, entry.params);
      entry.victim =
        entry.ticksLeft <= DANGER_TICKS
          ? guessVictim(entry.pv, game, players)
          : null;
    }

    board = top;
  }

  function ensureDom() {
    if (canvas && document.body.contains(canvas)) return;

    canvas = document.createElement("canvas");
    canvas.id = "ofio-attack-radar-canvas";
    Object.assign(canvas.style, {
      position: "fixed",
      inset: "0",
      width: "100vw",
      height: "100vh",
      pointerEvents: "none",
      zIndex: "41", // just above spawn-highlighter's 40, if both installed
    });
    document.body.appendChild(canvas);
    ctx = canvas.getContext("2d");

    panelEl = document.createElement("div");
    panelEl.id = "ofio-attack-radar-panel";
    Object.assign(panelEl.style, {
      position: "fixed",
      right: "12px",
      bottom: "12px",
      width: "240px",
      display: "flex",
      flexDirection: "column",
      gap: "4px",
      padding: "8px 10px",
      borderRadius: "8px",
      background: "rgba(15, 17, 26, 0.65)",
      backdropFilter: "blur(2px)",
      font: "600 11px/1.4 system-ui, sans-serif",
      color: "#fff",
      pointerEvents: "none",
      zIndex: "41",
      transition: "opacity 150ms linear",
    });
    document.body.appendChild(panelEl);

    window.addEventListener("resize", resizeCanvas, { passive: true });
    resizeCanvas();
  }

  function resizeCanvas() {
    if (!canvas) return;
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
  }

  function fmtSeconds(ticks) {
    return (ticks * TICK_MS) / 1000;
  }

  function renderPanel() {
    if (board.length === 0) {
      panelEl.innerHTML =
        '<div style="opacity:0.7;">Attack Radar — no bots found yet</div>';
      return;
    }
    const rows = board.map((entry) => {
      const secs = fmtSeconds(entry.ticksLeft).toFixed(1);
      const icon = entry.pv.type() === "NATION" ? "✦" : "▲";
      const name = escapeHtml(entry.pv.displayName());
      let targetText = "—";
      let dotColor = "rgba(255,255,255,0.35)";
      if (entry.victim) {
        const style = CONFIDENCE_STYLE[entry.victim.confidence];
        const [r, g, b] = style.color;
        dotColor = `rgb(${r},${g},${b})`;
        targetText = `→ ${escapeHtml(entry.victim.target.displayName())} (${style.label})`;
      } else if (entry.readiness && !entry.readiness.meetsReserve) {
        targetText = "saving troops";
      }
      const readyDim =
        entry.readiness && !entry.readiness.meetsReserve ? "opacity:0.55;" : "";
      return (
        `<div style="display:flex;flex-direction:column;gap:1px;${readyDim}">` +
        `<div style="display:flex;justify-content:space-between;gap:6px;">` +
        `<span>${icon} ${name}</span><span>${secs}s</span>` +
        `</div>` +
        `<div style="display:flex;align-items:center;gap:5px;font-weight:500;opacity:0.85;">` +
        `<span style="width:6px;height:6px;border-radius:50%;background:${dotColor};flex:none;"></span>` +
        `<span>${targetText}</span>` +
        `</div>` +
        `</div>`
      );
    });
    panelEl.innerHTML =
      '<div style="opacity:0.7;margin-bottom:2px;">Attack Radar — next decisions (heuristic)</div>' +
      rows.join('<div style="height:1px;background:rgba(255,255,255,0.08);margin:2px 0;"></div>');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[c]);
  }

  function drawCooldownRing(px, py, progress, worldSize, scale, color, now) {
    const radius = Math.max(6, Math.min(28, (worldSize || 10) * 1.4) * scale);
    const [r, g, b] = color;

    // Track
    ctx.beginPath();
    ctx.arc(px, py, radius, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(1.5, radius * 0.09);
    ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.18)`;
    ctx.stroke();

    // Sweep, starting at 12 o'clock, filling clockwise as the decision
    // tick approaches.
    const start = -Math.PI / 2;
    const end = start + Math.PI * 2 * progress;
    ctx.beginPath();
    ctx.arc(px, py, radius, start, end);
    ctx.lineWidth = Math.max(2, radius * 0.14);
    ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.95)`;
    ctx.stroke();

    // Gentle pulse core so it reads as "active" even mid-sweep.
    const pulse = 0.5 + 0.5 * Math.sin(now / 220);
    ctx.beginPath();
    ctx.arc(px, py, Math.max(1.5, radius * (0.12 + 0.03 * pulse)), 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.9)`;
    ctx.fill();
  }

  function drawDangerRing(px, py, worldSize, scale, color, now, seed) {
    const baseRadius = Math.max(6, Math.min(28, (worldSize || 10) * 1.4) * scale);
    const [r, g, b] = color;
    const phase = ((now + seed) % 900) / 900;
    const grow = 1 - Math.pow(1 - phase, 2);
    const radius = baseRadius * (0.7 + 0.6 * grow);
    const alpha = (1 - phase) * 0.8;

    ctx.beginPath();
    ctx.arc(px, py, radius, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(1.5, baseRadius * 0.1);
    ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(px, py, baseRadius * 0.5, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.85)`;
    ctx.fill();
  }

  function drawLink(ax, ay, vx, vy, color, now) {
    const [r, g, b] = color;
    const dashOffset = -((now / 30) % 24);
    ctx.save();
    ctx.setLineDash([8, 6]);
    ctx.lineDashOffset = dashOffset;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(vx, vy);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.6)`;
    ctx.stroke();
    ctx.restore();

    // Arrowhead at the victim end.
    const angle = Math.atan2(vy - ay, vx - ax);
    const size = 7;
    ctx.beginPath();
    ctx.moveTo(vx, vy);
    ctx.lineTo(
      vx - size * Math.cos(angle - Math.PI / 6),
      vy - size * Math.sin(angle - Math.PI / 6),
    );
    ctx.lineTo(
      vx - size * Math.cos(angle + Math.PI / 6),
      vy - size * Math.sin(angle + Math.PI / 6),
    );
    ctx.closePath();
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.8)`;
    ctx.fill();
  }

  function seedFor(id) {
    let seed = 0;
    for (let i = 0; i < id.length; i++) seed = (seed * 31 + id.charCodeAt(i)) % 2200;
    return seed;
  }

  function draw(now) {
    requestAnimationFrame(draw);

    const anchor = findAnchor();
    if (!anchor) {
      currentGame = null;
      currentTransform = null;
      if (canvas) canvas.style.display = "none";
      if (panelEl) panelEl.style.display = "none";
      return;
    }
    if (anchor.game !== currentGame) {
      // New match (or first load) — bot IDs are per-game, so stale cached
      // params would be actively wrong, not just outdated.
      paramsCache = new Map();
      board = [];
      lastRecompute = 0;
    }
    currentGame = anchor.game;
    currentTransform = anchor.transform;

    ensureDom();

    let inSpawnPhase = true;
    try {
      inSpawnPhase = currentGame.inSpawnPhase();
    } catch {
      inSpawnPhase = true;
    }
    const wantVisible = userEnabled && !inSpawnPhase;
    const target = wantVisible ? 1 : 0;
    const step = 16 / FADE_MS;
    opacity += Math.sign(target - opacity) * Math.min(step, Math.abs(target - opacity));

    if (opacity <= 0.001) {
      canvas.style.display = "none";
      panelEl.style.display = "none";
      return;
    }

    if (now - lastRecompute >= RECOMPUTE_MS) {
      lastRecompute = now;
      try {
        recomputeBoard(currentGame);
      } catch {
        // Leave the previous board in place rather than blanking on a
        // transient read error (e.g. mid-update player state).
      }
      renderPanel();
    }

    canvas.style.display = "block";
    panelEl.style.display = "flex";
    panelEl.style.opacity = String(opacity);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    ctx.globalAlpha = opacity;

    const scale = currentTransform.scale ?? 1;

    for (const entry of board) {
      if (entry.ticksLeft > DANGER_TICKS) continue;
      const loc = entry.pv.nameLocation && entry.pv.nameLocation();
      if (!loc) continue;
      let screen;
      try {
        screen = currentTransform.worldToScreenCoordinates({ x: loc.x, y: loc.y });
      } catch {
        continue;
      }

      const progress = 1 - entry.ticksLeft / entry.params.attackRate;
      const muted = entry.readiness && !entry.readiness.meetsReserve;
      const attackerColor = muted ? [150, 150, 150] : ATTACKER_COLOR;
      drawCooldownRing(screen.x, screen.y, progress, loc.size, scale, attackerColor, now);

      if (entry.victim && !muted) {
        const vloc = entry.victim.target.nameLocation && entry.victim.target.nameLocation();
        if (vloc) {
          let vscreen;
          try {
            vscreen = currentTransform.worldToScreenCoordinates({ x: vloc.x, y: vloc.y });
          } catch {
            vscreen = null;
          }
          if (vscreen) {
            const style = CONFIDENCE_STYLE[entry.victim.confidence];
            drawLink(screen.x, screen.y, vscreen.x, vscreen.y, style.color, now);
            drawDangerRing(
              vscreen.x,
              vscreen.y,
              vloc.size,
              scale,
              style.color,
              now,
              seedFor(entry.victim.target.id()),
            );
          }
        }
      }
    }

    ctx.globalAlpha = 1;
  }

  function onKeydown(e) {
    if (!e.altKey || e.key.toLowerCase() !== "p") return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    userEnabled = !userEnabled;
  }

  function start() {
    window.addEventListener("keydown", onKeydown);
    requestAnimationFrame(draw);
  }

  start();
})();
