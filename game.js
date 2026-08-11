'use strict';
/* =========================================================================
   HAMMER CLIMB — an original physics climbing game
   Built with Matter.js. Organized into clearly separated sections:
   CONFIG · SAVE/LOAD · AUDIO · CANVAS/CAMERA · LEVEL · PLAYER · HAMMER ·
   INPUT · COLLISIONS · UI · GAME LOOP / STATE MACHINE
   ========================================================================= */

const { Engine, World, Bodies, Body, Constraint, Composite, Events, Vector } = Matter;

/* ------------------------------------------------------------------ *
 * CONFIG
 * ------------------------------------------------------------------ */
const CONFIG = {
  ppm: 28,                 // pixels per meter, used only for the height readout
  armLength: 118,          // rest length of the hammer arm (constraint)
  maxReachMult: 1.35,      // how far past armLength the pointer may pull the hammer
  followStrength: 9,       // proportional gain: hammer velocity toward target
  maxHammerSpeed: 34,      // clamp on driven hammer speed
  rotFollowStrength: 0.32, // proportional gain: hammer angular velocity toward target
  fallLimitM: 14,          // meters below checkpoint that triggers a soft respawn
  levelHeightM: 260,       // total climbable height in meters
  worldHalfWidth: 480,     // level is this wide on each side of x=0
  maxFallSpeed: 15,        // hard cap on the player's downward velocity (px per physics step)
  playerFrictionAir: 0.026,// air resistance on the player — gives a natural, softer terminal fall speed
  difficulties: {
    // Gravity, stiffness, friction and restitution are tuned to feel like a
    // controllable, "heavy but fair" physics climber rather than a hard drop.
    easy:   { gravity: 0.42, stiffness: 0.82, friction: 0.9,  restitution: 0.02 },
    normal: { gravity: 0.52, stiffness: 0.72, friction: 0.75, restitution: 0.035 },
    hard:   { gravity: 0.65, stiffness: 0.62, friction: 0.55, restitution: 0.06 }
  }
};

// Runtime-tunable copies (rebuilt from settings + difficulty each game start)
let PHYS = { ...CONFIG.difficulties.normal };

/* ------------------------------------------------------------------ *
 * SAVE / LOAD  (localStorage)
 * ------------------------------------------------------------------ */
const SAVE_KEY = 'hammerClimb.save.v1';
function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) throw 0;
    const data = JSON.parse(raw);
    return Object.assign({
      bestHeight: 0,
      settings: { sound: true, music: true, vibration: true, difficulty: 'normal', sensitivity: 1 }
    }, data);
  } catch (e) {
    return { bestHeight: 0, settings: { sound: true, music: true, vibration: true, difficulty: 'normal', sensitivity: 1 } };
  }
}
function writeSave() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch (e) { /* storage unavailable — ignore */ }
}
let save = loadSave();

/* ------------------------------------------------------------------ *
 * AUDIO  (Web Audio API — no external files/music required)
 * ------------------------------------------------------------------ */
const Audio_ = (() => {
  let ctx = null;
  let musicNodes = null;
  function ensureCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function tone(freq, dur, type = 'sine', vol = 0.18, glide = 0) {
    if (!save.settings.sound) return;
    const c = ensureCtx();
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, c.currentTime);
    if (glide) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq + glide), c.currentTime + dur);
    gain.gain.setValueAtTime(vol, c.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
    osc.connect(gain).connect(c.destination);
    osc.start();
    osc.stop(c.currentTime + dur + 0.02);
  }
  function noiseHit(vol = 0.22, dur = 0.09) {
    if (!save.settings.sound) return;
    const c = ensureCtx();
    const buf = c.createBuffer(1, c.sampleRate * dur, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const src = c.createBufferSource();
    src.buffer = buf;
    const gain = c.createGain();
    gain.gain.setValueAtTime(vol, c.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
    const filt = c.createBiquadFilter();
    filt.type = 'lowpass'; filt.frequency.value = 1800;
    src.connect(filt).connect(gain).connect(c.destination);
    src.start();
  }
  return {
    unlock: () => ensureCtx(),
    hammerHit: () => noiseHit(0.25, 0.1),
    potHit: () => tone(140, 0.18, 'triangle', 0.16, -40),
    fall: () => tone(300, 0.4, 'sawtooth', 0.15, -220),
    checkpoint: () => { tone(523, 0.12, 'square', 0.15); setTimeout(() => tone(784, 0.16, 'square', 0.15), 90); },
    victory: () => { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => tone(f, 0.3, 'triangle', 0.16), i * 110)); },
    click: () => tone(700, 0.05, 'square', 0.08),
    startMusic() {
      if (musicNodes || !save.settings.music) return;
      const c = ensureCtx();
      const master = c.createGain(); master.gain.value = 0.05; master.connect(c.destination);
      const o1 = c.createOscillator(); o1.type = 'sine'; o1.frequency.value = 110;
      const o2 = c.createOscillator(); o2.type = 'sine'; o2.frequency.value = 165;
      const lfo = c.createOscillator(); lfo.frequency.value = 0.08;
      const lfoGain = c.createGain(); lfoGain.gain.value = 0.03;
      lfo.connect(lfoGain).connect(master.gain);
      o1.connect(master); o2.connect(master);
      o1.start(); o2.start(); lfo.start();
      musicNodes = { o1, o2, lfo, master };
    },
    stopMusic() {
      if (!musicNodes) return;
      try { musicNodes.o1.stop(); musicNodes.o2.stop(); musicNodes.lfo.stop(); } catch (e) {}
      musicNodes = null;
    },
    setMusic(on) { if (on) this.startMusic(); else this.stopMusic(); }
  };
})();

function vibrate(ms) { if (save.settings.vibration && navigator.vibrate) navigator.vibrate(ms); }

/* ------------------------------------------------------------------ *
 * CANVAS / RESIZE
 * ------------------------------------------------------------------ */
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
let DPR = Math.min(window.devicePixelRatio || 1, 2);

function resizeCanvas() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = window.innerWidth * DPR;
  canvas.height = window.innerHeight * DPR;
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

/* ------------------------------------------------------------------ *
 * LEVEL GENERATION
 * ------------------------------------------------------------------ */
// Small deterministic PRNG so the mountain is the same shape every run.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const PLATFORM_COLORS = {
  wood: '#a9713f', rock: '#7c7a86', barrel: '#c65b3a', pipe: '#5b8fae',
  cloud: '#e9edf4', tech: '#4b5ea8', bouncy: '#ff6ba8', ice: '#bfe9f2'
};

let level = { platforms: [], checkpoints: [], spawnY: 0, topY: 0, seed: 1337 };

function zoneForHeight(m) {
  if (m < 55) return 0;   // junkyard / wooden
  if (m < 120) return 1;  // rocky mountain
  if (m < 195) return 2;  // industrial / cloud
  return 3;                // futuristic tower / sky
}
const ZONE_NAMES = ['Junkyard', 'Rocky Mountain', 'Industrial Clouds', 'Sky Tower'];

function generateLevel() {
  const rng = makeRng(level.seed);
  const ppm = CONFIG.ppm;
  const spawnY = 0;
  const topY = -CONFIG.levelHeightM * ppm;
  level.spawnY = spawnY;
  level.topY = topY;
  level.platforms = [];
  level.checkpoints = [];

  // Starting ground — a generous safe platform under the player.
  level.platforms.push({ type: 'wood', x: 0, y: 40, w: 260, h: 40, angle: 0 });

  let y = 40;
  let x = 0;
  const step = 34; // average vertical meters->px step per platform, tuned by zone below
  let i = 0;
  while (y > topY + 400) {
    i++;
    const heightM = (spawnY - y) / ppm;
    const zone = zoneForHeight(heightM);
    const progress = -y / -topY; // 0..1 up the mountain

    // vertical gap grows with difficulty progress
    const gap = 70 + progress * 90 + rng() * 40;
    y -= gap;

    // horizontal wander, clamped to level bounds
    const wander = (rng() - 0.5) * (160 + progress * 220);
    x = Math.max(-CONFIG.worldHalfWidth + 80, Math.min(CONFIG.worldHalfWidth - 80, x + wander));

    // width narrows with progress
    const baseW = 190 - progress * 110;
    const w = Math.max(46, baseW + rng() * 40);
    const h = 26 + rng() * 10;

    let type = 'wood';
    let angle = 0;
    let extra = {};

    const roll = rng();
    if (zone === 0) {
      type = roll < 0.15 ? 'barrel' : 'wood';
      if (roll > 0.85) angle = (rng() - 0.5) * 0.5; // slanted crate
    } else if (zone === 1) {
      type = roll < 0.5 ? 'rock' : (roll < 0.7 ? 'barrel' : 'wood');
      if (roll > 0.6) angle = (rng() - 0.5) * 0.6; // slanted rock
      if (roll < 0.12) { type = 'ice'; extra.friction = 0.02; } // slippery surface
    } else if (zone === 2) {
      const r2 = rng();
      if (r2 < 0.28) { type = 'pipe'; }
      else if (r2 < 0.52) { type = 'cloud'; }
      else if (r2 < 0.7) { type = 'bouncy'; extra.restitution = 1.25; }
      else type = 'rock';
      if (r2 < 0.22) { extra.moving = { axis: 'x', amp: 60 + rng() * 70, speed: 0.4 + rng() * 0.5 }; }
      else if (r2 > 0.85) { extra.rotating = { speed: (rng() - 0.5) * 0.9 }; }
    } else {
      const r3 = rng();
      type = r3 < 0.5 ? 'tech' : 'cloud';
      if (r3 < 0.35) extra.moving = { axis: rng() < 0.5 ? 'x' : 'y', amp: 50 + rng() * 90, speed: 0.5 + rng() * 0.6 };
      if (r3 > 0.7) extra.rotating = { speed: (rng() - 0.5) * 1.1 };
      // very narrow precision platforms near the top
      if (progress > 0.8) { }
    }

    level.platforms.push(Object.assign({ type, x, y, w, h, angle }, extra));

    // occasional checkpoint roughly every ~10 platforms
    if (i % 9 === 0) {
      level.checkpoints.push({ x, y: y - 30 });
    }
  }

  // Final tower / peak platform + win sensor
  const peakY = topY;
  level.platforms.push({ type: 'tech', x: 0, y: peakY + 60, w: 220, h: 36, angle: 0, isPeak: true });
  level.winSensor = { x: 0, y: peakY, w: 200, h: 140 };

  // safety net far below the start
  level.voidY = spawnY + 3200;
}

/* ------------------------------------------------------------------ *
 * PHYSICS WORLD / BODIES
 * ------------------------------------------------------------------ */
let engine, world;
let bodies = { platforms: [], sensors: [], boundaries: [] };
let player, hammer, armConstraint;
let handOffset, gripOffset, headOffset;
let lastCheckpoint = { x: 0, y: 0 };
let checkpointsPassed = new Set();

function buildWorld() {
  engine = Engine.create();
  world = engine.world;
  world.gravity.y = PHYS.gravity;
  bodies = { platforms: [], sensors: [], boundaries: [] };

  // --- platforms ---
  level.platforms.forEach((p, idx) => {
    const opts = {
      isStatic: true,
      friction: p.friction !== undefined ? p.friction : PHYS.friction,
      restitution: p.restitution !== undefined ? p.restitution : PHYS.restitution,
      angle: p.angle || 0,
      label: 'platform'
    };
    const body = Bodies.rectangle(p.x, p.y, p.w, p.h, opts);
    body.plat = p;
    body.baseX = p.x; body.baseY = p.y; body.baseAngle = p.angle || 0;
    World.add(world, body);
    bodies.platforms.push(body);
  });

  // --- checkpoint sensors ---
  level.checkpoints.forEach(cp => {
    const s = Bodies.rectangle(cp.x, cp.y, 70, 90, { isStatic: true, isSensor: true, label: 'checkpoint' });
    s.cp = cp;
    World.add(world, s);
    bodies.sensors.push(s);
  });

  // --- win sensor ---
  const ws = level.winSensor;
  const winBody = Bodies.rectangle(ws.x, ws.y, ws.w, ws.h, { isStatic: true, isSensor: true, label: 'win' });
  World.add(world, winBody);
  bodies.sensors.push(winBody);

  // --- void / fall-through safety net ---
  const voidBody = Bodies.rectangle(0, level.voidY, CONFIG.worldHalfWidth * 4, 40, { isStatic: true, isSensor: true, label: 'void' });
  World.add(world, voidBody);
  bodies.sensors.push(voidBody);

  // --- side boundaries so the player can't wander off the level ---
  const wallH = Math.abs(level.topY) + 800;
  const wallY = (level.spawnY + level.topY) / 2;
  [-CONFIG.worldHalfWidth - 20, CONFIG.worldHalfWidth + 20].forEach(bx => {
    const wall = Bodies.rectangle(bx, wallY, 40, wallH, { isStatic: true, label: 'boundary' });
    World.add(world, wall);
    bodies.boundaries.push(wall);
  });

  buildPlayer();
  buildHammer();

  lastCheckpoint = { x: 0, y: 0 };
  checkpointsPassed = new Set();
}

function buildPlayer() {
  const sx = 0, sy = -30;
  // Higher density = more mass = more stability: the pot resists being
  // flung around by hammer impulses and settles quickly instead of
  // bouncing or sliding after a hit. Restitution kept very low so the pot
  // doesn't bounce off platforms it lands on.
  const pot = Bodies.trapezoid(sx, sy, 76, 56, 0.55, { friction: PHYS.friction * 0.9, restitution: 0.01, density: 0.016 });
  const torso = Bodies.circle(sx, sy - 42, 22, { friction: 0.4, restitution: 0.01, density: 0.007 });
  const head = Bodies.circle(sx, sy - 70, 14, { friction: 0.4, restitution: 0.01, density: 0.002 });

  player = Body.create({
    parts: [pot, torso, head],
    // frictionAir acts like air resistance: it grows with speed, so it
    // naturally caps how fast the player can fall instead of letting
    // gravity accelerate it indefinitely. Combined with the explicit
    // maxFallSpeed clamp in the game loop, falling stays controllable.
    frictionAir: CONFIG.playerFrictionAir,
    label: 'player'
  });
  Body.setPosition(player, { x: sx, y: sy }); // no-op, keeps intent explicit

  const handWorld = { x: sx + 24, y: sy - 40 };
  handOffset = Vector.sub(handWorld, player.position);

  World.add(world, player);
}

function buildHammer() {
  const sx = player.position.x + handOffset.x;
  const sy = player.position.y + handOffset.y;
  const len = CONFIG.armLength;

  const handle = Bodies.rectangle(sx + len / 2, sy, len, 12, { friction: 0.5, restitution: 0.05, density: 0.0025 });
  const head = Bodies.rectangle(sx + len, sy, 34, 34, { friction: 0.7, restitution: 0.05, density: 0.006, chamfer: { radius: 6 } });

  hammer = Body.create({
    parts: [handle, head],
    frictionAir: 0.015,
    label: 'hammer'
  });

  gripOffset = Vector.sub({ x: sx, y: sy }, hammer.position);
  headOffset = Vector.sub({ x: sx + len, y: sy }, hammer.position);

  World.add(world, hammer);

  armConstraint = Constraint.create({
    bodyA: player,
    pointA: handOffset,
    bodyB: hammer,
    pointB: gripOffset,
    length: 6,
    stiffness: PHYS.stiffness,
    damping: 0.15,
    label: 'arm'
  });
  World.add(world, armConstraint);
}

/* ------------------------------------------------------------------ *
 * MOVING / ROTATING PLATFORMS (kinematic-style, driven each tick)
 * ------------------------------------------------------------------ */
function updateKinematicPlatforms(t) {
  bodies.platforms.forEach(body => {
    const p = body.plat;
    if (p.moving) {
      const off = Math.sin(t * p.moving.speed) * p.moving.amp;
      const nx = p.moving.axis === 'x' ? body.baseX + off : body.baseX;
      const ny = p.moving.axis === 'y' ? body.baseY + off : body.baseY;
      Body.setPosition(body, { x: nx, y: ny });
    }
    if (p.rotating) {
      Body.setAngle(body, body.baseAngle + t * p.rotating.speed);
    }
  });
}

/* ------------------------------------------------------------------ *
 * INPUT (touch / mouse / keyboard)
 * ------------------------------------------------------------------ */
const input = { x: 0, y: 0, active: false, keys: {} };

function screenToWorld(sx, sy) {
  return { x: camera.x + sx, y: camera.y + sy };
}

function pointerPos(e) {
  const rect = canvas.getBoundingClientRect();
  const t = e.touches && e.touches[0] ? e.touches[0] : e;
  return { x: t.clientX - rect.left, y: t.clientY - rect.top };
}

canvas.addEventListener('pointerdown', e => {
  if (state !== 'playing') return;
  const p = pointerPos(e);
  input.x = p.x; input.y = p.y; input.active = true;
});
canvas.addEventListener('pointermove', e => {
  if (state !== 'playing') return;
  const p = pointerPos(e);
  input.x = p.x; input.y = p.y;
});
window.addEventListener('pointerup', () => { input.active = false; });
canvas.addEventListener('touchstart', e => { e.preventDefault(); }, { passive: false });
canvas.addEventListener('touchmove', e => { e.preventDefault(); }, { passive: false });

window.addEventListener('keydown', e => { input.keys[e.key.toLowerCase()] = true; });
window.addEventListener('keyup', e => { input.keys[e.key.toLowerCase()] = false; });

function applyKeyboardAim(dt) {
  // Alternative desktop control: arrows/WASD nudge an aim angle & reach; space = grab
  const rotSpeed = 2.4, reachSpeed = 220;
  if (!keyboardAim.init) { keyboardAim.angle = -Math.PI / 4; keyboardAim.reach = CONFIG.armLength; keyboardAim.init = true; }
  if (input.keys['arrowleft'] || input.keys['a']) keyboardAim.angle -= rotSpeed * dt;
  if (input.keys['arrowright'] || input.keys['d']) keyboardAim.angle += rotSpeed * dt;
  if (input.keys['arrowup'] || input.keys['w']) keyboardAim.reach = Math.min(CONFIG.armLength * CONFIG.maxReachMult, keyboardAim.reach + reachSpeed * dt);
  if (input.keys['arrowdown'] || input.keys['s']) keyboardAim.reach = Math.max(30, keyboardAim.reach - reachSpeed * dt);
  keyboardAim.usingKeys = input.keys['arrowleft'] || input.keys['arrowright'] || input.keys['arrowup'] ||
    input.keys['arrowdown'] || input.keys['a'] || input.keys['d'] || input.keys['w'] || input.keys['s'];
  if (input.keys[' ']) input.active = true;
}
const keyboardAim = { init: false };

/* ------------------------------------------------------------------ *
 * HAMMER CONTROL  (the core mechanic)
 * ------------------------------------------------------------------ */
function updateHammerControl(dt) {
  applyKeyboardAim(dt);

  const handWorld = Vector.add(player.position, Vector.rotate(handOffset, player.angle));
  let targetWorld;

  if (keyboardAim.usingKeys) {
    targetWorld = Vector.add(handWorld, { x: Math.cos(keyboardAim.angle) * keyboardAim.reach, y: Math.sin(keyboardAim.angle) * keyboardAim.reach });
  } else {
    const pointerWorld = screenToWorld(input.x, input.y);
    let toPointer = Vector.sub(pointerWorld, handWorld);
    const maxReach = CONFIG.armLength * CONFIG.maxReachMult;
    if (Vector.magnitude(toPointer) > maxReach) toPointer = Vector.mult(Vector.normalise(toPointer), maxReach);
    targetWorld = Vector.add(handWorld, toPointer);
  }

  const aimVec = Vector.sub(targetWorld, handWorld);
  const desiredAngle = Math.atan2(aimVec.y, aimVec.x);
  const sens = save.settings.sensitivity || 1;

  if (input.active) {
    const gripWorld = Vector.add(hammer.position, Vector.rotate(gripOffset, hammer.angle));
    const error = Vector.sub(targetWorld, gripWorld);
    let desiredVel = Vector.mult(error, CONFIG.followStrength * sens * 0.06);
    const speed = Vector.magnitude(desiredVel);
    const maxSp = CONFIG.maxHammerSpeed * sens;
    if (speed > maxSp) desiredVel = Vector.mult(Vector.normalise(desiredVel), maxSp);
    Body.setVelocity(hammer, desiredVel);

    let angleDiff = desiredAngle - hammer.angle;
    while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
    while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
    Body.setAngularVelocity(hammer, angleDiff * CONFIG.rotFollowStrength * sens);
  }
  // when not active, the hammer is left alone to swing freely under gravity + the arm constraint
}

/* ------------------------------------------------------------------ *
 * CAMERA
 * ------------------------------------------------------------------ */
const camera = { x: 0, y: 0 };
function updateCamera(dt) {
  const w = window.innerWidth, h = window.innerHeight;
  const targetX = player.position.x - w / 2;
  const targetY = player.position.y - h * 0.62;
  const smooth = 1 - Math.pow(0.001, dt); // frame-rate independent smoothing
  camera.x += (targetX - camera.x) * smooth;
  camera.y += (targetY - camera.y) * smooth;
}

/* ------------------------------------------------------------------ *
 * COLLISIONS
 * ------------------------------------------------------------------ */
function setupCollisions() {
  Events.on(engine, 'collisionStart', evt => {
    evt.pairs.forEach(pair => {
      const labels = [pair.bodyA.label, pair.bodyB.label];
      const other = pair.bodyA.label === 'hammer' ? pair.bodyB : (pair.bodyB.label === 'hammer' ? pair.bodyA : null);

      if (other && (other.label === 'platform')) {
        const speed = Vector.magnitude(hammer.velocity);
        if (speed > 3) { Audio_.hammerHit(); vibrate(15); spawnDust(pair.activeContacts && pair.activeContacts[0] ? pair.activeContacts[0].vertex : hammer.position); }
      }
      if (labels.includes('player') && labels.includes('platform')) {
        const speed = Vector.magnitude(player.velocity);
        if (speed > 6) Audio_.potHit();
      }
      if (labels.includes('player') && labels.includes('checkpoint')) {
        const cpBody = pair.bodyA.label === 'checkpoint' ? pair.bodyA : pair.bodyB;
        onCheckpoint(cpBody.cp);
      }
      if (labels.includes('player') && labels.includes('win')) {
        onVictory();
      }
      if (labels.includes('player') && labels.includes('void')) {
        onFall(true);
      }
    });
  });
}

let dust = [];
function spawnDust(pos) {
  if (dust.length > 40) return;
  for (let i = 0; i < 4; i++) {
    dust.push({ x: pos.x, y: pos.y, vx: (Math.random() - 0.5) * 2.5, vy: -Math.random() * 2, life: 1 });
  }
}
function updateDust(dt) {
  dust.forEach(d => { d.x += d.vx; d.y += d.vy; d.vy += 0.05; d.life -= dt * 1.6; });
  dust = dust.filter(d => d.life > 0);
}

function onCheckpoint(cp) {
  const key = cp.x + ',' + cp.y;
  if (hardMode) return; // checkpoints disabled in hard mode
  if (checkpointsPassed.has(key)) return;
  checkpointsPassed.add(key);
  lastCheckpoint = { x: cp.x, y: cp.y - 20 };
  showToast('CHECKPOINT REACHED');
  Audio_.checkpoint();
  vibrate(20);
}

function onFall(hardVoid) {
  Audio_.fall();
  showToast('FALL!');
  const respawn = hardMode ? { x: 0, y: -30 } : lastCheckpoint;
  Body.setPosition(player, respawn);
  Body.setVelocity(player, { x: 0, y: 0 });
  Body.setAngularVelocity(player, 0);
  Body.setAngle(player, 0);
  const hx = respawn.x + handOffset.x, hy = respawn.y + handOffset.y;
  Body.setPosition(hammer, { x: hx + CONFIG.armLength / 2, y: hy });
  Body.setVelocity(hammer, { x: 0, y: 0 });
  Body.setAngularVelocity(hammer, 0);
  Body.setAngle(hammer, 0);
}

// Hard safety cap on downward speed — on top of the higher frictionAir and
// lower gravity, this guarantees the player can never free-fall out of
// control, no matter how far the drop.
function clampPlayerFallSpeed() {
  if (player.velocity.y > CONFIG.maxFallSpeed) {
    Body.setVelocity(player, { x: player.velocity.x, y: CONFIG.maxFallSpeed });
  }
}

function checkFallLimit() {
  if (player.position.y > lastCheckpoint.y + CONFIG.fallLimitM * CONFIG.ppm + 260) {
    onFall(false);
  }
}

function onVictory() {
  if (state !== 'playing') return;
  state = 'victory';
  Audio_.victory();
  vibrate([30, 40, 30]);
  const finalM = Math.round(highestHeightM);
  if (finalM > save.bestHeight) { save.bestHeight = finalM; writeSave(); }
  document.getElementById('finalHeight').textContent = finalM + 'm';
  document.getElementById('finalTime').textContent = formatTime(elapsed);
  document.getElementById('victoryBestHeight').textContent = save.bestHeight + 'm';
  showScreen('victoryScreen');
  document.getElementById('hud').classList.add('hidden');
}

/* ------------------------------------------------------------------ *
 * RENDERING
 * ------------------------------------------------------------------ */
function zoneBgColors(zone) {
  return [
    ['#f3c96b', '#e88a4d'], // junkyard sunset
    ['#8fb6d9', '#5c85ad'], // rocky mountain sky
    ['#5f6fae', '#33396b'], // industrial clouds
    ['#1a1a3d', '#050512']  // sky tower / space
  ][zone];
}

function draw() {
  const w = window.innerWidth, h = window.innerHeight;
  ctx.clearRect(0, 0, w, h);

  const heightM = state === 'playing' || state === 'victory' ? Math.max(0, (level.spawnY - (player ? player.position.y : 0)) / CONFIG.ppm) : 0;
  const zone = zoneForHeight(heightM);
  const [c1, c2] = zoneBgColors(zone);
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, c1); grad.addColorStop(1, c2);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  if (state !== 'playing' && state !== 'paused' && state !== 'victory') {
    drawIdleBackground();
    return;
  }
  if (!player) return;

  drawParallaxHills(zone);

  ctx.save();
  ctx.translate(-camera.x, -camera.y);

  bodies.platforms.forEach(b => drawPlatform(b));
  drawDust();
  drawHammerBody();
  drawPlayerBody();
  drawPeakFlag();

  ctx.restore();
}

function drawIdleBackground() {
  const w = window.innerWidth, h = window.innerHeight;
  const t = performance.now() / 1000;
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  for (let i = 0; i < 5; i++) {
    const x = ((t * 18 + i * 220) % (w + 200)) - 100;
    const y = 60 + i * 70 % (h * 0.5);
    drawCloud(x, y, 50);
  }
}

function drawParallaxHills(zone) {
  const w = window.innerWidth, h = window.innerHeight;
  const t = performance.now() / 1000;
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < 4; i++) {
    const px = ((-camera.x * 0.1 + i * 260) % (w + 300)) - 150;
    drawCloud(px, 60 + (i % 2) * 50 + Math.sin(t * 0.3 + i) * 6, 45);
  }
  ctx.restore();
}

function drawCloud(x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r * 0.6, 0, Math.PI * 2);
  ctx.arc(x + r * 0.6, y + 6, r * 0.5, 0, Math.PI * 2);
  ctx.arc(x - r * 0.6, y + 8, r * 0.45, 0, Math.PI * 2);
  ctx.fill();
}

function drawPlatform(body) {
  const p = body.plat;
  const color = PLATFORM_COLORS[p.type] || '#888';
  ctx.save();
  ctx.translate(body.position.x, body.position.y);
  ctx.rotate(body.angle);
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 3;
  const rx = Math.min(10, p.h / 3);
  roundRect(-p.w / 2, -p.h / 2, p.w, p.h, rx);
  ctx.fill(); ctx.stroke();
  // simple texture accents per type
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fillRect(-p.w / 2 + 4, -p.h / 2 + 4, p.w - 8, 4);
  if (p.type === 'bouncy') { ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.fillRect(-p.w/2+6,-2,p.w-12,4); }
  ctx.restore();
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawDust() {
  dust.forEach(d => {
    ctx.fillStyle = `rgba(255,240,210,${Math.max(0, d.life * 0.6)})`;
    ctx.beginPath(); ctx.arc(d.x, d.y, 5 * d.life + 1, 0, Math.PI * 2); ctx.fill();
  });
}

function drawPlayerBody() {
  ctx.save();
  // pot (part 1) — draw using its own rotation/position (compound parts already world-updated)
  const pot = player.parts[1], torso = player.parts[2], head = player.parts[3];

  // pot
  ctx.save();
  ctx.translate(pot.position.x, pot.position.y);
  ctx.rotate(pot.angle);
  ctx.fillStyle = '#c9713a';
  ctx.strokeStyle = '#7a3f1c';
  ctx.lineWidth = 4;
  ctx.beginPath();
  pot.vertices.forEach((v, i) => {
    const lx = v.x - pot.position.x, ly = v.y - pot.position.y;
    // undo rotation to get local coords for a clean redraw path aligned with ctx.rotate
    const cos = Math.cos(-pot.angle), sin = Math.sin(-pot.angle);
    const rx = lx * cos - ly * sin, ry = lx * sin + ly * cos;
    i === 0 ? ctx.moveTo(rx, ry) : ctx.lineTo(rx, ry);
  });
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(-28, -6); ctx.lineTo(28, -6); ctx.stroke();
  ctx.restore();

  // torso
  ctx.save();
  ctx.translate(torso.position.x, torso.position.y);
  ctx.fillStyle = '#4a90d9';
  ctx.strokeStyle = '#2c5c8a';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(0, 0, torso.circleRadius, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.restore();

  // head
  ctx.save();
  ctx.translate(head.position.x, head.position.y);
  ctx.fillStyle = '#f4c99a';
  ctx.strokeStyle = '#c9925c';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(0, 0, head.circleRadius, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  // face
  const handWorld = Vector.add(player.position, Vector.rotate(handOffset, player.angle));
  const dir = Math.sign(handWorld.x - head.position.x) || 1;
  ctx.fillStyle = '#1c1533';
  ctx.beginPath(); ctx.arc(3 * dir, -2, 1.8, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(-3 * dir, -2, 1.8, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#1c1533'; ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.arc(0, 3, 5, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
  ctx.restore();

  // arm line from hand to hammer grip
  const gripWorld = Vector.add(hammer.position, Vector.rotate(gripOffset, hammer.angle));
  ctx.strokeStyle = '#f4c99a';
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(handWorld.x, handWorld.y); ctx.lineTo(gripWorld.x, gripWorld.y); ctx.stroke();

  ctx.restore();
}

function drawHammerBody() {
  const handle = hammer.parts[1], head = hammer.parts[2];
  ctx.save();
  ctx.translate(handle.position.x, handle.position.y);
  ctx.rotate(handle.angle);
  ctx.fillStyle = '#8a5a2b';
  ctx.strokeStyle = '#4d2f14';
  ctx.lineWidth = 2.5;
  roundRect(-CONFIG.armLength / 2, -6, CONFIG.armLength, 12, 5);
  ctx.fill(); ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.translate(head.position.x, head.position.y);
  ctx.rotate(head.angle);
  ctx.fillStyle = '#9aa3b2';
  ctx.strokeStyle = '#454b57';
  ctx.lineWidth = 3;
  roundRect(-17, -17, 34, 34, 7);
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.fillRect(-13, -13, 26, 6);
  ctx.restore();
}

function drawPeakFlag() {
  const ws = level.winSensor;
  ctx.save();
  ctx.translate(ws.x, ws.y - 30);
  ctx.strokeStyle = '#ccc'; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -90); ctx.stroke();
  ctx.fillStyle = '#ff6b5b';
  ctx.beginPath(); ctx.moveTo(0, -90); ctx.lineTo(46, -76); ctx.lineTo(0, -60); ctx.closePath(); ctx.fill();
  ctx.restore();
}

/* ------------------------------------------------------------------ *
 * UI HELPERS
 * ------------------------------------------------------------------ */
let toastTimer = null;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 1600);
}
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  if (id) document.getElementById(id).classList.remove('hidden');
}
function formatTime(sec) {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
}

/* ------------------------------------------------------------------ *
 * SETTINGS UI WIRING
 * ------------------------------------------------------------------ */
function applySettingsToUI() {
  document.getElementById('soundToggle').checked = save.settings.sound;
  document.getElementById('musicToggle').checked = save.settings.music;
  document.getElementById('vibrationToggle').checked = save.settings.vibration;
  document.getElementById('difficultySelect').value = save.settings.difficulty;
  document.getElementById('sensitivitySlider').value = save.settings.sensitivity;
  document.getElementById('menuBestHeight').textContent = save.bestHeight + 'm';
}
document.getElementById('soundToggle').addEventListener('change', e => { save.settings.sound = e.target.checked; writeSave(); });
document.getElementById('musicToggle').addEventListener('change', e => { save.settings.music = e.target.checked; Audio_.setMusic(e.target.checked && state === 'playing'); writeSave(); });
document.getElementById('vibrationToggle').addEventListener('change', e => { save.settings.vibration = e.target.checked; writeSave(); });
document.getElementById('difficultySelect').addEventListener('change', e => { save.settings.difficulty = e.target.value; writeSave(); });
document.getElementById('sensitivitySlider').addEventListener('input', e => { save.settings.sensitivity = parseFloat(e.target.value); writeSave(); });

/* ------------------------------------------------------------------ *
 * GAME STATE MACHINE + LOOP
 * ------------------------------------------------------------------ */
let state = 'menu'; // menu | howto | settings | playing | paused | victory
let hardMode = false;
let elapsed = 0;
let highestHeightM = 0;
let lastFrameTime = performance.now();

function startGame() {
  Audio_.unlock();
  hardMode = document.getElementById('hardModeCheck').checked;
  PHYS = { ...CONFIG.difficulties[save.settings.difficulty] };
  level.seed = 1337; // deterministic mountain
  generateLevel();
  buildWorld();
  setupCollisions();
  camera.x = player.position.x - window.innerWidth / 2;
  camera.y = player.position.y - window.innerHeight * 0.62;
  elapsed = 0;
  highestHeightM = 0;
  dust = [];
  state = 'playing';
  document.getElementById('bestHeightValue').textContent = save.bestHeight + 'm';
  document.getElementById('hud').classList.remove('hidden');
  showScreen(null);
  Audio_.setMusic(save.settings.music);
}

function pauseGame() {
  if (state !== 'playing') return;
  state = 'paused';
  showScreen('pauseMenu');
}
function resumeGame() {
  state = 'playing';
  showScreen(null);
  lastFrameTime = performance.now();
}
function restartGame() { startGame(); }
function goMainMenu() {
  state = 'menu';
  Audio_.stopMusic();
  document.getElementById('hud').classList.add('hidden');
  applySettingsToUI();
  showScreen('mainMenu');
}

function tick(now) {
  requestAnimationFrame(tick);
  let dt = (now - lastFrameTime) / 1000;
  lastFrameTime = now;
  dt = Math.min(dt, 1 / 30); // clamp for tab-switch spikes

  if (state === 'playing') {
    elapsed += dt;
    updateHammerControl(dt);
    updateKinematicPlatforms(now / 1000);
    Engine.update(engine, dt * 1000);
    clampPlayerFallSpeed();
    updateCamera(dt);
    updateDust(dt);
    checkFallLimit();

    const curHeightM = Math.max(0, (level.spawnY - player.position.y) / CONFIG.ppm);
    if (curHeightM > highestHeightM) highestHeightM = curHeightM;
    document.getElementById('heightValue').textContent = Math.round(curHeightM) + 'm';
    if (highestHeightM > save.bestHeight) {
      document.getElementById('bestHeightValue').textContent = Math.round(highestHeightM) + 'm';
    }
  }

  draw();
}

/* ------------------------------------------------------------------ *
 * BUTTON WIRING
 * ------------------------------------------------------------------ */
function click(fn) { return () => { Audio_.click(); fn(); }; }

document.getElementById('playBtn').addEventListener('click', click(startGame));
document.getElementById('howToBtn').addEventListener('click', click(() => showScreen('howToScreen')));
document.getElementById('settingsBtn').addEventListener('click', click(() => { applySettingsToUI(); showScreen('settingsScreen'); }));
document.querySelectorAll('.back-btn').forEach(b => b.addEventListener('click', click(() => showScreen(state === 'paused' ? 'pauseMenu' : 'mainMenu'))));

document.getElementById('pauseBtn').addEventListener('click', click(pauseGame));
document.getElementById('resumeBtn').addEventListener('click', click(resumeGame));
document.getElementById('restartBtn').addEventListener('click', click(restartGame));
document.getElementById('pauseSettingsBtn').addEventListener('click', click(() => { applySettingsToUI(); showScreen('settingsScreen'); }));
document.getElementById('mainMenuBtn').addEventListener('click', click(goMainMenu));

document.getElementById('playAgainBtn').addEventListener('click', click(startGame));
document.getElementById('victoryMenuBtn').addEventListener('click', click(goMainMenu));

/* ------------------------------------------------------------------ *
 * INIT
 * ------------------------------------------------------------------ */
applySettingsToUI();
showScreen('mainMenu');
requestAnimationFrame(tick);
