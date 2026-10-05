/* Structured settlement lattice — raw WebGL, no dependency.
 *
 * The previous version was a random scatter with lines between neighbours,
 * which is the particles.js look: no structure, no depth, reads amateur at any
 * point count. This is a strict GRID displaced by a travelling wave and drawn
 * in perspective, so the eye reads order first and motion second.
 *
 * It is a ledger, not a landscape. Rows recede like entries in a book, a rare
 * point lights the way a transfer resolves — green posted, amber held, red
 * refused — and the density at the horizon is the fleet you cannot see
 * individually.
 *
 * ~57k points in one draw call. Displacement happens on the GPU, so the CPU
 * cost per frame is a uniform update. Falls back to a static gradient if WebGL
 * is unavailable, and paints a single still frame under prefers-reduced-motion.
 *
 * ONE module for every surface, configured per canvas by data attributes (or,
 * for the accent only, by the script tag's data-theme, as before):
 *   data-accent   usertools (default; the settlement spectrum) | usertrust | gold
 *                 | neutral | violet     which accent the sparse lit points carry
 *   data-mode     live (default; continuous, pointer + scroll reactive)
 *                 | wave-once   one wave on load that eases to rest, then FROZEN:
 *                   no loop, no pointer, no scroll work; for heavy pages
 *                 | static      a single still frame
 *   data-dpr-max  cap on the device pixel ratio (default 2; 1.5 for wave-once)
 * prefers-reduced-motion always means static. The loop also stops while the tab
 * is hidden. With no WebGL the canvas gets .net-fallback and, if the page has no
 * rule for it, a gradient in the accent.
 */
(() => {
/* THEME — the only per-site difference in this file.
   The usertools.ai field carries the settlement spectrum (posted/held/resumed/
   refused) because that page shows four outcomes. usertrust carries ONE accent:
   gold. Its four slots are kept as GRADES of gold rather than collapsed to a
   single literal — the rare-lit point is a texture, and one flat value makes the
   field read as a pattern instead of a ledger.
   Selected with <script src="lattice.js" data-theme="usertrust">. */
const THEMES = {
  usertools: {
    z1: 'vec3(0.188, 0.820, 0.345)', z2: 'vec3(1.000, 0.690, 0.125)',
    z3: 'vec3(0.286, 0.616, 1.000)', z4: 'vec3(1.000, 0.357, 0.357)',
    depth: 'vec3(0.36, 0.60, 1.00)', wake: 'vec3(0.42, 0.66, 1.0)',
    fb: ['77,163,255', '48,209,88'],
  },
  usertrust: {
    z1: 'vec3(1.000, 0.796, 0.392)', z2: 'vec3(0.960, 0.706, 0.235)',
    z3: 'vec3(0.870, 0.890, 0.930)', z4: 'vec3(1.000, 0.870, 0.560)',
    depth: 'vec3(0.62, 0.66, 0.74)', wake: 'vec3(1.00, 0.80, 0.42)',
    fb: ['232,181,75', '200,204,212'],
  },
  /* silver: status and any surface with no accent of its own */
  neutral: {
    z1: 'vec3(0.800, 0.820, 0.860)', z2: 'vec3(0.950, 0.960, 0.980)',
    z3: 'vec3(0.620, 0.650, 0.700)', z4: 'vec3(0.880, 0.890, 0.920)',
    depth: 'vec3(0.72, 0.74, 0.80)', wake: 'vec3(0.85, 0.87, 0.92)',
    fb: ['200,204,212', '126,132,144'],
  },
  /* the lab map's product accent */
  violet: {
    z1: 'vec3(0.608, 0.482, 1.000)', z2: 'vec3(0.740, 0.640, 1.000)',
    z3: 'vec3(0.860, 0.820, 1.000)', z4: 'vec3(0.500, 0.380, 0.920)',
    depth: 'vec3(0.55, 0.45, 0.95)', wake: 'vec3(0.66, 0.55, 1.00)',
    fb: ['155,123,255', '200,204,212'],
  },
};
THEMES.gold = THEMES.usertrust;
THEMES.silver = THEMES.neutral;
/* The script tag's attributes are the default for every canvas on the page; a
   canvas's own attributes win. document.currentScript is null when this file is
   bundled as a module, which is why the canvas can carry everything itself. */
const SCRIPT = document.currentScript;
const pick = (canvas, key) => (canvas.dataset[key] != null ? canvas.dataset[key]
  : (SCRIPT && SCRIPT.dataset[key] != null ? SCRIPT.dataset[key] : undefined));
const STILL_T = 2.2;         // the still frame's time; wave-once comes to rest on it
const LIT_SHIFT = 0.58;      // puts the lit slice on the first accent grade at STILL_T
const WAVE_MS = 2800;
/* canvases whose wave has already come to rest: a WebGL context restore builds a
   fresh Lattice on the same canvas, which must paint the rest frame, not replay it */
const RESTED = new WeakSet();        // how long wave-once travels before it freezes

  const vertSrc = (T) => `
    precision highp float;
    attribute vec2 a_uv;              // grid coordinate, 0..1
    uniform float u_time;
    uniform float u_aspect;
    uniform float u_dpr;
    uniform float u_spread;           // lateral width of the sheet
    uniform float u_depth;            // how far it recedes
    uniform vec2  u_mouse;            // cursor, clip space
    uniform float u_mouseAmt;         // 0..1, eased on enter/leave
    uniform vec2  u_trail[3];         // lagging cursor history — a wake
    uniform vec2  u_mvel;             // cursor velocity, clip space / frame
    uniform vec2  u_ripple;           // where the rings are emitted from — lags
    uniform float u_horizon;          // where the plane converges, clip space
    uniform vec4  u_damp[6];          // UI elements that press on the sheet:
                                      // xy = centre, zw = half-size, 0..1 screen
    uniform float u_dampCount;
    uniform float u_scroll;           // 0..1 down the document
    uniform float u_litShift;         // 0 live; non-live modes pick which slice is lit

    // Signed distance to a box, in screen space corrected for aspect so the
    // falloff is circular in pixels rather than stretched.
    float boxSD(vec2 p, vec2 c, vec2 h, float aspect) {
      vec2 q = abs(p - c) - h;
      q.x *= aspect;
      return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
    }
    varying float v_alpha;
    varying vec3  v_tint;

    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

    void main() {
      // strict lattice — the structure is the point
      float x = (a_uv.x - 0.5) * u_spread;
      float z = 0.45 + a_uv.y * u_depth;

      // layered travelling wave; slow enough to read as breathing, not noise
      // Higher spatial frequency: more crests across the sheet so it reads as a
      // structured field rather than one slow swell. Amplitudes come down as
      // frequency goes up, otherwise the crests collide and it turns to noise.
      // Scroll does not scroll the field — it MORPHS it. Frequency climbs and
      // the phase advances as you descend, so the surface the reader sees at
      // the roadmap is continuous with the hero but never the same shape.
      float sc = u_scroll;
      float fq = 1.0 + sc * 0.85;
      float ph = sc * 7.5;

      float w = sin(x * 3.8 * fq + u_time * 0.62 + ph) * 0.34
              + sin(z * 3.0 * fq - u_time * 0.46 - ph * 0.7) * 0.31
              + sin((x + z) * 2.3 * fq + u_time * 0.28 + ph * 0.4) * 0.21
              + sin(x * 8.1 * fq - z * 4.3 + u_time * 0.95) * 0.10   // fine ripple
              + sin(z * 13.0 * fq + u_time * 0.38) * 0.045;          // row shimmer
      // the camera also drifts down a little as you descend the page
      float y = w * 0.21 * (1.0 + sc * 0.30) - (0.36 + sc * 0.10);

      // Perspective divide. x and y must share a focal length or the sheet is
      // sheared rather than projected — using 0.62 for x and a different value
      // for y is what kept this a thin ribbon instead of a ground plane that
      // runs off the bottom of the frame and converges at the horizon.
      float inv = 1.0 / z;
      float focal = 1.55;
      vec2 pos = vec2(x * inv * focal / u_aspect, y * inv * focal + u_horizon);

      // ── the UI damps the field ────────────────────────────────────────────
      // Primary elements act as mass on the sheet: the wave flattens and dims
      // beneath them and swells in the gaps between. Damping is measured on the
      // UNDISPLACED position, otherwise the wave would move points in and out
      // of their own damping region and shimmer at the boundary.
      vec2 scr = vec2(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
      float damp = 1.0;
      for (int i = 0; i < 6; i++) {
        if (float(i) >= u_dampCount) break;
        float sd = boxSD(scr, u_damp[i].xy, u_damp[i].zw, u_aspect);
        // A slot's influence scales with its own SIZE: boxSD at zero half-size
        // is plain distance-to-centre, so unclaimed, just-claimed, released and
        // boot-state slots all pressed a phantom dimple (46% strength at their
        // stale centres). Below ~1% of the viewport a slot now weighs nothing.
        float on = smoothstep(0.0, 0.012, min(u_damp[i].z, u_damp[i].w));
        damp *= mix(1.0, 0.52 + 0.48 * smoothstep(-0.02, 0.16, sd), on);
      }

      // re-displace with the damped amplitude, then re-project
      y = w * 0.21 * (1.0 + sc * 0.30) * (0.52 + 0.48 * damp) - (0.36 + sc * 0.10);
      pos = vec2(x * inv * focal / u_aspect, y * inv * focal + u_horizon);

      // ── cursor: a disturbance in the field, not a spotlight ──────────────
      // Three effects compose. A bloom that opens the lattice around the
      // pointer; a WAKE from three lagging history positions so fast movement
      // leaves a trail rather than teleporting; and a RIPPLE that propagates
      // outward in rings, so the surface reacts like something was dropped in
      // it. All measured after projection so they track the cursor on screen.
      vec2 dv = pos - u_mouse;
      dv.x *= u_aspect;
      float md = length(dv);

      float bump = exp(-md * md * 43.1) * u_mouseAmt;   // ~110px @1440

      // wake — each trail point contributes less than the one before it
      float wake = 0.0;
      for (int i = 0; i < 3; i++) {
        vec2 tv = pos - u_trail[i];
        tv.x *= u_aspect;
        float td = length(tv);
        wake += exp(-td * td * 56.0) * (0.55 - float(i) * 0.15);   // ~96px
      }
      wake *= u_mouseAmt;

      // ripple — rings are EMITTED, not carried. Measuring them from the live
      // pointer made the pattern rigid: perfectly concentric, translating with
      // the cursor and never distorting however fast it moved, which is what
      // read as static. Two things give it drag. The source lags well behind
      // the bloom, so rings stay roughly where they were made and the pointer
      // pulls away from them; and the radius is stretched along the direction
      // of travel, compressing the spacing ahead and opening it out behind —
      // the asymmetry a moving source makes on water.
      vec2 rv = pos - u_ripple;
      rv.x *= u_aspect;
      vec2 mv = vec2(u_mvel.x * u_aspect, u_mvel.y);
      float sp = length(mv);
      vec2 vd = sp > 1e-5 ? mv / sp : vec2(0.0);
      // clamped: past ~1.0 the metric folds back on itself behind the source
      // and the rings turn inside out
      float rd = length(rv) + dot(rv, vd) * clamp(sp * 13.0, 0.0, 0.55);
      float ring = sin(rd * 76.7 - u_time * 4.8) * exp(-rd * rd * 28.0) * u_mouseAmt;   // ~136px

      // the pointer also warps the wave's own phase nearby, so the pattern
      // bends around it instead of merely getting brighter
      float warp = exp(-md * md * 31.4) * u_mouseAmt;   // ~129px

      pos += normalize(dv + vec2(1e-5)) * (bump * 0.0184 + wake * 0.0094);
      pos += u_mvel * warp * 0.69;                     // smear along travel
      pos.y += bump * 0.0094 + ring * 0.0032;

      gl_Position = vec4(pos, 0.0, 1.0);
      gl_PointSize = (clamp(2.9 * inv, 0.55, 3.4) + bump * 1.30 + wake * 0.85
                      + max(ring, 0.0) * 0.18) * u_dpr;

      // fade out at the horizon and at the very front edge. The curve is
      // deliberately steep so the mid-field reads dense and the horizon glows
      // rather than greying out uniformly.
      float far  = smoothstep(u_depth + 0.60, 0.7, z);
      float near = smoothstep(0.45, 1.05, z);
      float depth01 = clamp((z - 0.45) / u_depth, 0.0, 1.0);
      v_alpha = pow(far, 1.28) * near * 1.22;
      // crests catch more light than troughs — gives the sheet a surface
      v_alpha *= 0.72 + 0.44 * smoothstep(-0.35, 0.55, w);
      // and the field reads brightest in the gaps between the UI
      v_alpha *= 0.58 + 0.42 * damp;
      // never dissolves into true black — the network is always at least faintly there
      v_alpha = max(v_alpha, 0.06 * near * far);

      // a small minority of points carry a settlement colour
      float id = hash(a_uv * 97.0);
      float beat = fract(id + u_time * 0.045 + u_litShift);
      float lit  = smoothstep(0.972, 0.999, beat);
      // Kept in sync with the agent-fleet figure's ambient action palette — the loupe is
      // this field magnified, and an outcome that exists at one scale and
      // not the other breaks the claim. Blue arrived when Resume did.
      vec3 zone = id < 0.62 ? ${T.z1}     // accent grade 1
                : id < 0.80 ? ${T.z2}     // accent grade 2
                : id < 0.92 ? ${T.z3}     // accent grade 3
                            : ${T.z4};    // accent grade 4
      // depth grading: warm-white up close, cooling into brand blue at distance.
      // Keeps the ground black while giving the field somewhere to recede TO.
      vec3 base = mix(vec3(1.0, 1.0, 1.0), ${T.depth}, depth01 * 0.80);
      v_tint  = mix(base, zone, lit * 0.94);
      v_alpha = mix(v_alpha, min(v_alpha * 3.4 + 0.30, 0.95), lit);
      v_alpha = min(v_alpha + bump * 0.20 + wake * 0.13 + max(ring, 0.0) * 0.030, 1.0);
      // and the disturbance tints toward the ruling blue as it passes
      v_tint = mix(v_tint, ${T.wake}, min(bump * 0.27 + wake * 0.15, 0.35));
    }`;

  const FRAG = `
    precision mediump float;
    varying float v_alpha;
    varying vec3  v_tint;
    void main() {
      // round the square point sprite and soften its edge
      vec2 d = gl_PointCoord - vec2(0.5);
      float r = dot(d, d);
      if (r > 0.25) discard;
      float edge = smoothstep(0.25, 0.02, r);
      gl_FragColor = vec4(v_tint, v_alpha * edge);
    }`;

  /* Half pitch below 980: a phone shows this field through a quarter of
     the pixels and none of the parallax range, and 14,240 points reads
     identically there at a quarter of the vertex cost. A width crossing
     reloads the page, so boot-time is the whole story. */
  const M = matchMedia('(max-width:979px)').matches;
  const COLS = M ? 160 : 320, ROWS = M ? 89 : 178;   // 56,960 points wide, 14,240 narrow — still one draw call

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error('shader: ' + gl.getShaderInfoLog(sh));
    }
    return sh;
  }

  class Lattice {
    constructor(canvas) {
      this.canvas = canvas;
      this.reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const accent = pick(canvas, 'accent') || pick(canvas, 'theme');
      this.theme = Object.prototype.hasOwnProperty.call(THEMES, accent) ? THEMES[accent] : THEMES.usertools;
      const asked = pick(canvas, 'mode');
      /* reduced motion is always a still frame, whatever the page asked for */
      this.mode = this.reduce ? 'static' : (asked === 'wave-once' || asked === 'static' ? asked : 'live');
      if (this.mode === 'wave-once' && RESTED.has(canvas)) this.mode = 'static';
      this.live = this.mode === 'live';
      this.elapsed = 0;           // wave-once: time actually travelled, not wall time
      this.done = false;
      this.dprMax = +pick(canvas, 'dprMax') || (this.mode === 'wave-once' ? 1.5 : 2);
      this.visible = true;
      this.raf = 0;
      this.t0 = 0;

      // WebGL2 first. Nothing here NEEDS it today — a static point buffer
      // displaced in the vertex shader runs identically on WebGL1 — but it is
      // ~97% supported and it is the path to instancing and transform feedback
      // if this ever becomes a real particle simulation rather than a sheet.
      // WebGL1 stays as the fallback so the visual degrades, never disappears.
      const opts = { alpha: true, antialias: true, premultipliedAlpha: false, depth: false,
                     powerPreference: 'high-performance' };
      const gl = canvas.getContext('webgl2', opts)
              || canvas.getContext('webgl', opts)
              || canvas.getContext('experimental-webgl', opts);
      if (!gl) { this.fallback(); return; }
      this.gl = gl;
      this.isGL2 = typeof WebGL2RenderingContext !== 'undefined'
                && gl instanceof WebGL2RenderingContext;

      const prog = gl.createProgram();
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, vertSrc(this.theme)));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { this.fallback(); return; }
      gl.useProgram(prog);
      this.prog = prog;

      // the lattice itself never changes — upload once
      const uv = new Float32Array(COLS * ROWS * 2);
      let i = 0;
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          uv[i++] = c / (COLS - 1);
          uv[i++] = r / (ROWS - 1);
        }
      }
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'a_uv');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      this.count = COLS * ROWS;

      this.u = {
        time:   gl.getUniformLocation(prog, 'u_time'),
        aspect: gl.getUniformLocation(prog, 'u_aspect'),
        dpr:    gl.getUniformLocation(prog, 'u_dpr'),
        spread: gl.getUniformLocation(prog, 'u_spread'),
        depth:  gl.getUniformLocation(prog, 'u_depth'),
        mouse:  gl.getUniformLocation(prog, 'u_mouse'),
        mouseAmt: gl.getUniformLocation(prog, 'u_mouseAmt'),
        horizon: gl.getUniformLocation(prog, 'u_horizon'),
        damp:    gl.getUniformLocation(prog, 'u_damp'),
        dampCount: gl.getUniformLocation(prog, 'u_dampCount'),
        scroll:  gl.getUniformLocation(prog, 'u_scroll'),
        trail:   gl.getUniformLocation(prog, 'u_trail'),
        mvel:    gl.getUniformLocation(prog, 'u_mvel'),
        ripple:  gl.getUniformLocation(prog, 'u_ripple'),
        litShift: gl.getUniformLocation(prog, 'u_litShift'),
      };

      // Elements that press on the sheet. Selector list is read from the
      // canvas, so markup decides what damps rather than this file.
      this.dampSel = (canvas.dataset.damp || '').split(',').map(x=>x.trim()).filter(Boolean);
      this.dampBuf = new Float32Array(24);          // 6 slots, eased
      this.dampTarget = new Float32Array(24);       // where they want to be
      this.slots = [null, null, null, null, null, null];   // element per slot
      this.dampNodes = [];
      this.dampN = 6;
      this.refreshNodes();
      // markup can change between sections; re-collect occasionally, not per frame
      if (this.live) window.addEventListener('resize', () => this.refreshNodes(), { passive: true });

      // pointer state, eased so entering and leaving are both smooth
      this.scroll = 0;
      this.mouse = [0, 0];
      this.mouseTarget = [0, 0];
      this.prevMouse = [0, 0];
      this.mvel = [0, 0];
      this.ripple = [0, 0];
      this.seen = false;                  // no pointer yet — see the snap below
      this.trail = new Float32Array(6);   // three lagging positions
      this.amt = 0;
      this.amtTarget = 0;
      if (this.live) window.addEventListener('pointermove', (e) => {
        this.mouseTarget = [
          (e.clientX / window.innerWidth) * 2 - 1,
          -((e.clientY / window.innerHeight) * 2 - 1),
        ];
        /* First sighting snaps every follower onto the pointer. The bloom got
           away with easing in from the origin because u_mouseAmt hid it, but
           the ripple source follows at 0.05 and would still be halfway across
           the field once the effect faded up — a ring front sweeping in from
           the middle of the screen that nothing caused. */
        if (!this.seen) {
          this.seen = true;
          this.mouse = this.mouseTarget.slice();
          this.prevMouse = this.mouseTarget.slice();
          this.ripple = this.mouseTarget.slice();
          for (let i = 0; i < 3; i++) {
            this.trail[i * 2] = this.mouseTarget[0];
            this.trail[i * 2 + 1] = this.mouseTarget[1];
          }
        }
        this.amtTarget = 1;
        this.start();
      }, { passive: true });
      if (this.live) document.addEventListener('pointerleave', () => { this.amtTarget = 0; });

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);   // additive: density reads as light
      gl.clearColor(0, 0, 0, 0);

      this.resize();
      if (getComputedStyle(canvas).position === 'fixed') {
        // always on screen — no intersection gating, just track the viewport
        window.addEventListener('resize', () => this.resize(), { passive: true });
      } else {
        new ResizeObserver(() => this.resize()).observe(canvas.parentElement || canvas);
        if ('IntersectionObserver' in window) {
          new IntersectionObserver((es) => {
            // newest entry — es[0] is the OLDEST in a batched delivery
            this.visible = es[es.length - 1].isIntersecting;
            this.visible ? this.start() : this.stop();
          }, { threshold: 0 }).observe(canvas);
        }
      }

      /* CONTEXT LOSS: stop dead-spinning on lost (preventDefault is what
         makes restored fire at all); on restore, hand the canvas to a fresh
         instance — the GL build is inline in this constructor, and a rare
         re-run's duplicate listeners are bounded and inert (every path they
         reach checks this.gl). The old instance nulls its gl and goes quiet. */
      canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        this.stop();
        this.gl = null;
      });
      canvas.addEventListener('webglcontextrestored', () => {
        new Lattice(canvas);
      }, { once: true });
      /* once:true is the fix for compounding instances: each
         instance arms exactly ONE restoration, and the fresh instance
         arms the next — N loss cycles now mean one live lattice, not N. */

      // The fixed background never scrolls away, but the TAB can: without
      // this the loop ran for the life of the page even fully hidden.
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) this.stop();
        else this.start();
      });

      this.live ? this.start() : this.mode === 'wave-once' ? this.start() : this.frame(STILL_T);
    }

    /* No WebGL: the class is the page's hook; if the page paints nothing for it,
       paint the accent's gradient on the black ground so the surface still reads
       as the same field rather than flat black. */
    fallback() {
      const c = this.canvas;
      c.classList.add('net-fallback');
      if (getComputedStyle(c).backgroundImage === 'none') {
        const [a, b] = this.theme.fb;
        c.style.background =
          `radial-gradient(118% 78% at 50% -6%,rgba(${a},.11) 0%,rgba(${a},0) 62%),` +
          `radial-gradient(88% 66% at 12% 104%,rgba(${b},.06) 0%,rgba(${b},0) 66%),#000`;
      }
    }

    refreshNodes() {
      this.dampNodes = this.dampSel.length
        ? [...document.querySelectorAll(this.dampSel.join(','))]
        : [];
    }

    /* Damping regions, read every frame and eased into place.
     *
     * Slots are OWNED BY AN ELEMENT for as long as it is on screen, rather than
     * filled positionally from the first six in document order. Positional
     * assignment was the last source of jumpiness and it was worst at the foot
     * of the page: down there the elements are small and numerous, so the
     * moment the topmost one left the viewport every remaining element shifted
     * up a slot and ALL SIX targets changed on the same frame — a coordinated
     * lurch, not a drift. With ownership, one element leaving disturbs exactly
     * one slot, and that slot has already faded to nothing before it is reused.
     */
    updateDamp() {
      const vw = window.innerWidth, vh = window.innerHeight;
      const FADE = vh * 0.9;           // long ramp: entry and exit are gradual

      const visible = new Set();
      const rects = new Map();
      for (const el of this.dampNodes) {
        const r = el.getBoundingClientRect();
        if (r.bottom < -FADE || r.top > vh + FADE || !r.width || !r.height) continue;
        visible.add(el);
        rects.set(el, r);
      }

      // release slots whose element has gone, but only once it has shrunk away
      for (let i = 0; i < 6; i++) {
        const el = this.slots[i];
        if (el && !visible.has(el)) {
          this.dampTarget[i*4+2] = 0;
          this.dampTarget[i*4+3] = 0;
          if (this.dampBuf[i*4+2] < 0.002 && this.dampBuf[i*4+3] < 0.002) this.slots[i] = null;
        }
      }

      // give free slots to visible elements that do not have one yet
      for (const el of visible) {
        if (this.slots.includes(el)) continue;
        const free = this.slots.indexOf(null);
        if (free === -1) break;                  // all six busy; skip this one
        this.slots[free] = el;
        // start from the element's own centre at zero size so it grows in place
        const r = rects.get(el);
        this.dampBuf[free*4+0] = (r.left + r.width / 2) / vw;
        this.dampBuf[free*4+1] = (r.top + r.height / 2) / vh;
        this.dampBuf[free*4+2] = 0;
        this.dampBuf[free*4+3] = 0;
      }

      for (let i = 0; i < 6; i++) {
        const el = this.slots[i];
        if (!el || !visible.has(el)) continue;
        const r = rects.get(el);
        // weight ramps with viewport proximity so a slot is weightless at the
        // moment it is claimed and again by the time it is released
        const over = Math.min(r.bottom + FADE, vh + FADE - r.top) / FADE;
        const wgt = Math.max(0, Math.min(1, over));
        this.dampTarget[i*4+0] = (r.left + r.width / 2) / vw;
        this.dampTarget[i*4+1] = (r.top + r.height / 2) / vh;
        this.dampTarget[i*4+2] = ((r.width / 2) / vw - 0.004) * wgt;
        this.dampTarget[i*4+3] = ((r.height / 2) / vh - 0.004) * wgt;
      }

      for (let i = 0; i < 24; i++) {
        this.dampBuf[i] += (this.dampTarget[i] - this.dampBuf[i]) * 0.07;
      }
    }

    resize() {
      // the field is fixed to the viewport, not to a parent box
      const fixed = getComputedStyle(this.canvas).position === 'fixed';
      const host = this.canvas.parentElement || this.canvas;
      const w = fixed ? window.innerWidth  : host.clientWidth;
      const h = fixed ? window.innerHeight : host.clientHeight;
      if (!w || !h || !this.gl) return;
      const dpr = Math.min(window.devicePixelRatio || 1, this.dprMax);
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = h + 'px';
      this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      this.dpr = dpr;
      this.aspect = w / h;
      if (!this.live && (this.mode === 'static' || this.done)) this.frame(STILL_T);
    }

    start() {
      if (this.mode === 'static' || this.done || this.raf || !this.visible || !this.gl) return;
      const loop = (ts) => {
        if (this.mode === 'wave-once') {
          // one wave: ease to rest ON the still frame, then stop for good. Time
          // is accumulated, so a pause (hidden tab, off-screen) does not eat it.
          this.elapsed += this.last ? ts - this.last : 0;
          this.last = ts;
          const p = Math.min(1, this.elapsed / WAVE_MS);
          this.frame(STILL_T * (1 - (1 - p) ** 3));
          if (p >= 1) { this.done = true; this.raf = 0; RESTED.add(this.canvas); return; }
        } else {
          if (!this.t0) this.t0 = ts;
          this.frame((ts - this.t0) / 1000);
        }
        this.raf = requestAnimationFrame(loop);
      };
      this.raf = requestAnimationFrame(loop);
    }

    stop() { if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; } this.last = 0; }

    frame(t) {
      const { gl, u } = this;
      if (!gl || !this.canvas.width) return;
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(u.time, t);
      gl.uniform1f(u.aspect, this.aspect || 1);
      gl.uniform1f(u.dpr, this.dpr || 1);
      // a wide short surface wants more spread; a tall panel wants more depth
      const a = this.aspect || 1;
      gl.uniform1f(u.spread, a > 1.4 ? 2.7 : 2.1);
      gl.uniform1f(u.depth,  a > 1.4 ? 3.2 : 4.0);
      // sit the horizon high so the plane fills the lower frame and converges
      // into a dense band rather than floating in the middle of the section
      gl.uniform1f(u.horizon, a > 1.4 ? 0.30 : 0.16);

      // measure the damping elements against the canvas box each frame, so the
      // field responds to layout, resize and reflow without extra bookkeeping
      if (this.live) this.updateDamp();
      gl.uniform4fv(u.damp, this.dampBuf);
      gl.uniform1f(u.dampCount, this.dampN);

      let sc = 0;
      if (this.live) {
        const doc = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
        sc = Math.min(1, Math.max(0, window.scrollY / doc));
      }
      // ease toward the scroll position so fast flicks morph smoothly
      this.scroll = this.scroll + (sc - this.scroll) * 0.045;
      gl.uniform1f(u.scroll, this.scroll);
      /* Which points carry the accent is a function of time, and at the still
         frame's time that slice happens to be the near-white grade, so a frozen
         field showed no accent at all. Non-live modes shift the slice onto the
         primary grade; live is untouched (0.0). */
      gl.uniform1f(u.litShift, this.live ? 0 : LIT_SHIFT);

      // ease toward the pointer so the bloom trails the cursor slightly
      this.prevMouse[0] = this.mouse[0];
      this.prevMouse[1] = this.mouse[1];
      this.mouse[0] += (this.mouseTarget[0] - this.mouse[0]) * 0.12;
      this.mouse[1] += (this.mouseTarget[1] - this.mouse[1]) * 0.12;

      // velocity, damped — drives the smear along direction of travel
      this.mvel[0] += ((this.mouse[0] - this.prevMouse[0]) - this.mvel[0]) * 0.30;
      this.mvel[1] += ((this.mouse[1] - this.prevMouse[1]) - this.mvel[1]) * 0.30;

      // trail: each point chases the one ahead of it, so the wake curves
      this.trail[0] += (this.mouse[0]    - this.trail[0]) * 0.16;
      this.trail[1] += (this.mouse[1]    - this.trail[1]) * 0.16;
      this.trail[2] += (this.trail[0]    - this.trail[2]) * 0.13;
      this.trail[3] += (this.trail[1]    - this.trail[3]) * 0.13;
      this.trail[4] += (this.trail[2]    - this.trail[4]) * 0.10;
      this.trail[5] += (this.trail[3]    - this.trail[5]) * 0.10;

      /* The ripple source follows at less than half the bloom's rate, which
         is the whole effect: move fast and the pointer outruns its own rings.
         Stop, and the source catches up over ~20 frames and the pattern
         recentres — a wake settling, not a light switching off. */
      this.ripple[0] += (this.mouse[0] - this.ripple[0]) * 0.052;
      this.ripple[1] += (this.mouse[1] - this.ripple[1]) * 0.052;

      this.amt += (this.amtTarget - this.amt) * 0.07;
      gl.uniform2f(u.mouse, this.mouse[0], this.mouse[1]);
      gl.uniform1f(u.mouseAmt, this.live ? this.amt : 0);
      gl.uniform2fv(u.trail, this.trail);
      gl.uniform2f(u.mvel, this.live ? this.mvel[0] : 0, this.live ? this.mvel[1] : 0);
      gl.uniform2f(u.ripple, this.ripple[0], this.ripple[1]);

      gl.drawArrays(gl.POINTS, 0, this.count);
    }
  }

  const boot = () => document.querySelectorAll('[data-network]').forEach((c) => new Lattice(c));
  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', boot)
    : boot();
})();
