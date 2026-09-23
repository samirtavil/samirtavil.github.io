// Printed CMYK halftone of the whole page, after Photoshop's filter stack.
// The background image and the page's type, ovals and rules are painted into one
// composite (positions read from the real DOM). A WebGL pass then screens that composite
// like offset print: cyan, magenta, yellow and black dot grids on paper, each dot taking
// one ink amount from its centre, with rough edges, ink spread and paper grain. The
// screens are anchored to the document, so they scroll with the page like a printed
// sheet and dots keep their colour. Slow waves shift where the dots sample. The DOM stays in
// place, transparent, for links, selection and screen readers. Without WebGL the plain
// page stays visible.
(() => {
  const page = document.querySelector(".page");
  if (!page) return;

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const canvas = document.createElement("canvas");
  canvas.className = "dot-screen";
  canvas.setAttribute("aria-hidden", "true");

  const gl = canvas.getContext("webgl", { alpha: false, antialias: false });
  if (!gl) return;

  const vertexSrc = `
    attribute vec2 a_pos;
    void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
  `;

  const fragmentSrc = `
    #ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
    #else
    precision mediump float;
    #endif
    uniform sampler2D u_comp;
    uniform vec2 u_res;
    uniform vec2 u_view;
    uniform vec2 u_scroll;
    uniform float u_dpr;
    uniform float u_time;

    const float CELL = 3.2;
    const vec3 PAPER = vec3(0.965, 0.955, 0.925);
    // Inks as multipliers on the paper, close to ideal so the simple CMYK split keeps hues
    // (real process magenta would turn the pink red).
    const vec3 CYAN = vec3(0.0, 0.92, 1.0);
    const vec3 MAGENTA = vec3(1.0, 0.0, 0.9);
    const vec3 YELLOW = vec3(1.0, 0.97, 0.0);
    const vec3 BLACK = vec3(0.12, 0.12, 0.12);

    vec2 hash22(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.xx + p3.yz) * p3.zy);
    }

    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      float a = hash22(i).x;
      float b = hash22(i + vec2(1.0, 0.0)).x;
      float c = hash22(i + vec2(0.0, 1.0)).x;
      float d = hash22(i + vec2(1.0, 1.0)).x;
      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }

    float tri(float x) { return asin(sin(x)) * 0.6366; }
    // Square wave with a short ramp instead of a hard step, so field edges don't draw a line.
    float sq(float x) { return clamp(sin(x) * 4.0, -1.0, 1.0); }

    // RGB to CMYK with partial black generation, so greys print as a mix of black and colour dots.
    vec4 cmyk(vec3 rgb) {
      vec3 cmy = 1.0 - rgb;
      float k = min(min(cmy.x, cmy.y), cmy.z) * 0.5;
      return vec4((cmy - k) / (1.0 - k), k);
    }

    // One ink's screen. Each dot takes the ink amount at its centre; dots vary a little in
    // size, place and density, and the four nearest cells are checked so neighbours can
    // overlap without clipping.
    float ink(vec2 g, float angle, float seed, vec4 mask) {
      float s = sin(angle);
      float c = cos(angle);
      mat2 rot = mat2(c, s, -s, c);
      mat2 inv = mat2(c, -s, s, c);
      vec2 v = rot * g / CELL;
      vec2 base = floor(v);
      vec2 f = v - base;
      vec2 dir = vec2(f.x < 0.5 ? -1.0 : 1.0, f.y < 0.5 ? -1.0 : 1.0);
      // Ink spread: a soft rim, plus a rough edge from noise in the paper.
      float rough = (noise(g * 0.9 + seed) - 0.5) * 0.22 + (noise(g * 2.3 + seed * 1.7) - 0.5) * 0.1;
      float soft = 0.07 + 1.0 / (CELL * u_dpr);
      float cover = 0.0;
      for (int i = 0; i < 4; i++) {
        vec2 o = vec2((i == 1 || i == 3) ? dir.x : 0.0, i >= 2 ? dir.y : 0.0);
        vec2 cell = base + o;
        vec2 rnd = hash22(cell + seed);
        vec2 center = cell + 0.5 + (rnd - 0.5) * 0.16;
        vec2 centerG = inv * (center * CELL);
        float amount = dot(cmyk(texture2D(u_comp, clamp((centerG - u_scroll) / u_view, 0.0, 1.0)).rgb), mask);
        vec2 rnd2 = hash22(cell + seed + 7.0);
        // Slightly under the area-true 0.564 to make up for the soft, spreading rim.
        float radius = 0.53 * sqrt(amount) * (0.88 + 0.24 * rnd2.x);
        float dist = length(v - center) * (1.0 + rough);
        float dot1 = 1.0 - smoothstep(radius - soft, radius + soft, dist);
        cover = max(cover, dot1 * (0.86 + 0.14 * rnd2.y));
      }
      return cover;
    }

    void main() {
      vec2 p = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y);
      // Document coordinates: screens, waves and grain travel with the page.
      vec2 q = p / u_dpr + u_scroll;
      float t = u_time;

      // Shared wave: square and triangle generators shift the screens in fields, slowly.
      vec2 w;
      w.x = sq(q.y * 0.011 + t * 0.20) * 2.2 + tri(q.y * 0.031 + q.x * 0.006 - t * 0.33) * 1.6;
      w.y = sq(q.x * 0.009 - t * 0.16) * 2.0 + tri(q.x * 0.027 + q.y * 0.005 + t * 0.27) * 1.4;

      // Each plate is slightly out of register and wobbles on its own.
      vec2 wc = w + vec2(0.4, 0.0) + vec2(tri(q.y * 0.050 + t * 0.40), tri(q.x * 0.050 - t * 0.30)) * 0.5;
      vec2 wm = w + vec2(-0.3, 0.3) + vec2(tri(q.y * 0.047 - t * 0.35 + 2.0), tri(q.x * 0.052 + t * 0.33 + 1.0)) * 0.5;
      vec2 wy = w + vec2(0.0, -0.4) + vec2(tri(q.y * 0.053 + t * 0.30 + 4.0), tri(q.x * 0.049 - t * 0.37 + 3.0)) * 0.5;

      // Photoshop's default CMYK halftone angles: C 108, M 162, Y 90, K 45 degrees.
      float c = ink(q + wc, 1.885, 0.0, vec4(1.0, 0.0, 0.0, 0.0));
      float m = ink(q + wm, 2.827, 17.0, vec4(0.0, 1.0, 0.0, 0.0));
      float y = ink(q + wy, 1.571, 41.0, vec4(0.0, 0.0, 1.0, 0.0));
      float k = ink(q + w, 0.785, 63.0, vec4(0.0, 0.0, 0.0, 1.0));

      float grain = hash22(floor(q * u_dpr)).x - 0.5;
      vec3 col = PAPER * (1.0 + grain * 0.05);
      col *= mix(vec3(1.0), CYAN, c);
      col *= mix(vec3(1.0), MAGENTA, m);
      col *= mix(vec3(1.0), YELLOW, y);
      col *= mix(vec3(1.0), BLACK, k);

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  function compile(type, src) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
  }

  const vs = compile(gl.VERTEX_SHADER, vertexSrc);
  const fs = compile(gl.FRAGMENT_SHADER, fragmentSrc);
  if (!vs || !fs) return;

  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, "a_pos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const u = {};
  for (const name of ["u_res", "u_view", "u_scroll", "u_dpr", "u_time"]) {
    u[name] = gl.getUniformLocation(program, name);
  }

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  // ---------- Composite: background image + page content, in viewport pixels ----------

  // Painted at half resolution: each texel then averages an area about the size of a
  // dot, so thin strokes still produce (smaller) dots instead of falling between them.
  const COMP_SCALE = 0.5;
  const comp = document.createElement("canvas");
  const ctx = comp.getContext("2d");
  let background = null;
  let glyphs = [];
  let ovals = [];
  let rules = [];
  let dirty = true;
  let paintedScroll = { x: -1, y: -1 };

  function inkOf(el) {
    return getComputedStyle(el).getPropertyValue("--ink").trim() || "#000";
  }

  // Read every visible character, oval and underline from the DOM, in document coordinates.
  function collect() {
    const sx = window.scrollX;
    const sy = window.scrollY;
    glyphs = [];
    ovals = [];
    rules = [];

    const range = document.createRange();
    const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      const cs = getComputedStyle(el);
      const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const stretched = cs.fontStretch !== "100%" && cs.fontStretch !== "normal";
      const spacing = parseFloat(cs.letterSpacing) || 0;
      const upper = cs.textTransform === "uppercase";
      const ink = inkOf(el);
      const link = el.closest("a");

      ctx.font = font;
      if ("fontStretch" in ctx) ctx.fontStretch = stretched ? "expanded" : "normal";

      const text = node.data;
      for (let i = 0; i < text.length; i++) {
        if (/\s/.test(text[i])) continue;
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const r = range.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const ch = upper ? text[i].toUpperCase() : text[i];
        const m = ctx.measureText(ch);
        const ascent = m.fontBoundingBoxAscent || r.height * 0.8;
        // Match the DOM's glyph width exactly, whatever width the canvas font resolved to.
        const scaleX = m.width ? (r.width - spacing) / m.width : 1;
        glyphs.push({ ch, x: r.left + sx, y: r.top + sy + ascent, scaleX, font, stretched, ink, link });
      }
    }

    for (const el of page.querySelectorAll(".oval")) {
      const r = el.getBoundingClientRect();
      const width = parseFloat(getComputedStyle(el).borderTopWidth) || 0;
      ovals.push({ x: r.left + sx, y: r.top + sy, w: r.width, h: r.height, width, ink: inkOf(el), link: el.closest("a") });
    }

    for (const el of page.querySelectorAll("*")) {
      if (el.classList.contains("oval")) continue;
      const cs = getComputedStyle(el);
      const width = parseFloat(cs.borderBottomWidth) || 0;
      if (!width || cs.borderBottomStyle === "none") continue;
      const ink = inkOf(el);
      const link = el.closest("a");
      for (const r of el.getClientRects()) {
        rules.push({ x: r.left + sx, y: r.bottom + sy - width, w: r.width, h: width, ink, link });
      }
    }

    dirty = true;
  }

  function alphaFor(link) {
    return link && link.matches(":hover") ? 0.55 : 1;
  }

  function paint(viewW, viewH) {
    const sx = window.scrollX;
    const sy = window.scrollY;
    const k = COMP_SCALE;
    const compW = Math.max(1, Math.round(viewW * k));
    const compH = Math.max(1, Math.round(viewH * k));
    if (comp.width !== compW || comp.height !== compH) {
      comp.width = compW;
      comp.height = compH;
    }

    // Background: covers the whole document and scrolls with it, like the CSS fallback.
    const docW = document.documentElement.clientWidth;
    const docH = Math.max(document.documentElement.scrollHeight, viewH);
    const scale = Math.max(docW / background.width, docH / background.height);
    const bw = background.width * scale;
    const bh = background.height * scale;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.globalAlpha = 1;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(background, (docW - bw) / 2 - sx, -sy, bw, bh);

    let font = "";
    for (const g of glyphs) {
      const y = g.y - sy;
      if (y < -200 || y > viewH + 200) continue;
      if (g.font !== font) {
        font = g.font;
        ctx.font = font;
      }
      if ("fontStretch" in ctx) ctx.fontStretch = g.stretched ? "expanded" : "normal";
      ctx.globalAlpha = alphaFor(g.link);
      ctx.fillStyle = g.ink;
      ctx.setTransform(k * g.scaleX, 0, 0, k, k * (g.x - sx), k * y);
      ctx.fillText(g.ch, 0, 0);
    }
    ctx.setTransform(k, 0, 0, k, 0, 0);

    for (const o of ovals) {
      ctx.globalAlpha = alphaFor(o.link);
      ctx.strokeStyle = o.ink;
      ctx.lineWidth = o.width;
      ctx.beginPath();
      ctx.ellipse(o.x - sx + o.w / 2, o.y - sy + o.h / 2, Math.max(0, o.w / 2 - o.width / 2), Math.max(0, o.h / 2 - o.width / 2), 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    for (const r of rules) {
      ctx.globalAlpha = alphaFor(r.link);
      ctx.fillStyle = r.ink;
      ctx.fillRect(r.x - sx, r.y - sy, r.w, r.h);
    }

    // Keyboard focus ring, since the real one is hidden under the canvas.
    const focused = document.activeElement;
    if (focused && page.contains(focused) && focused.matches(":focus-visible")) {
      const r = focused.getBoundingClientRect();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = inkOf(focused);
      ctx.lineWidth = 2;
      ctx.strokeRect(r.left - 4, r.top - 4, r.width + 8, r.height + 8);
    }
    ctx.globalAlpha = 1;

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, comp);
    paintedScroll = { x: sx, y: sy };
    dirty = false;
  }

  // ---------- WebGL loop ----------

  let dpr = 1;
  let viewW = 1;
  let viewH = 1;
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    viewW = Math.max(1, Math.round(rect.width));
    viewH = Math.max(1, Math.round(rect.height));
    canvas.width = Math.round(viewW * dpr);
    canvas.height = Math.round(viewH * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
    collect();
  }

  const start = performance.now();

  function draw(now) {
    if (dirty || window.scrollX !== paintedScroll.x || window.scrollY !== paintedScroll.y) {
      paint(viewW, viewH);
    }

    gl.uniform2f(u.u_res, canvas.width, canvas.height);
    gl.uniform2f(u.u_view, viewW, viewH);
    gl.uniform2f(u.u_scroll, paintedScroll.x, paintedScroll.y);
    gl.uniform1f(u.u_dpr, dpr);
    gl.uniform1f(u.u_time, reduceMotion ? 0 : (now - start) / 1000);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  let running = false;
  function loop(now) {
    if (!running) return;
    // With reduced motion, only redraw when the page itself changed.
    if (!reduceMotion || dirty || window.scrollY !== paintedScroll.y || window.scrollX !== paintedScroll.x) {
      draw(now);
    }
    requestAnimationFrame(loop);
  }

  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    running = false;
    canvas.remove();
    document.documentElement.classList.remove("gl-on");
  });

  function begin() {
    document.body.append(canvas);
    resize();
    draw(start);
    // Hide the DOM's own ink only once the screened version is on screen.
    document.documentElement.classList.add("gl-on");

    window.addEventListener("resize", resize);
    document.fonts.addEventListener("loadingdone", collect);
    const markDirty = () => { dirty = true; };
    document.addEventListener("pointerover", markDirty, { passive: true });
    document.addEventListener("pointerout", markDirty, { passive: true });
    document.addEventListener("focusin", markDirty);
    document.addEventListener("focusout", markDirty);

    running = true;
    requestAnimationFrame(loop);
  }

  const img = new Image();
  img.onload = async () => {
    // Soften the image a little so dots follow its tones rather than its pixel noise.
    const soft = document.createElement("canvas");
    soft.width = Math.round(img.naturalWidth / 4);
    soft.height = Math.round(img.naturalHeight / 4);
    const sctx = soft.getContext("2d");
    sctx.imageSmoothingQuality = "high";
    sctx.drawImage(img, 0, 0, soft.width, soft.height);
    background = soft;

    await document.fonts.ready;
    begin();
  };
  img.src = "img/background.webp";
})();
