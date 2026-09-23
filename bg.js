// The page printed as a static CMYK halftone, drawn in WebGL.
// The background image and the page's type, ovals and rules (positions read from the real
// DOM) are screened together: cyan, magenta, yellow and black dot grids on paper, each dot
// taking one ink amount from its centre, with rough edges, ink spread and paper grain.
// Greys go mostly to the black plate, as a printer would. The type has its own, finer
// black plate on top, so it is made of dots too and multiplies with whatever is under it,
// but stays readable.
// A fixed wave distortion shifts where the dots sample, like Photoshop's Wave filter. The
// screens are anchored to the document, so the page scrolls like a printed sheet. The DOM
// stays in place, transparent, for links, selection and screen readers. Without WebGL the
// plain page stays visible.
(() => {
  const page = document.querySelector(".page");
  if (!page) return;

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
    uniform sampler2D u_ink;
    uniform vec2 u_res;
    uniform vec2 u_view;
    uniform vec2 u_scroll;
    uniform float u_dpr;

    const float CELL = 4.0;
    const float TYPE_CELL = 2.2;
    const vec3 PAPER = vec3(0.965, 0.955, 0.925);
    // Inks as multipliers on the paper.
    const vec3 CYAN = vec3(0.0, 0.92, 1.0);
    const vec3 MAGENTA = vec3(1.0, 0.0, 0.9);
    const vec3 YELLOW = vec3(1.0, 0.97, 0.0);
    const vec3 BLACK = vec3(0.1, 0.1, 0.1);

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

    // RGB to CMYK with heavy black generation: greys print mostly as black dots, colour
    // plates only carry what is actually coloured. The image is lightened first.
    vec4 cmyk(vec3 rgb) {
      rgb = 1.0 - (1.0 - rgb) * 0.7;
      vec3 cmy = 1.0 - rgb;
      float k = min(min(cmy.x, cmy.y), cmy.z) * 0.9;
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
      float rough = (noise(g * 0.7 + seed) - 0.5) * 0.22 + (noise(g * 1.8 + seed * 1.7) - 0.5) * 0.1;
      float soft = 0.06 + 1.0 / (CELL * u_dpr);
      float cover = 0.0;
      for (int i = 0; i < 4; i++) {
        vec2 o = vec2((i == 1 || i == 3) ? dir.x : 0.0, i >= 2 ? dir.y : 0.0);
        vec2 cell = base + o;
        vec2 rnd = hash22(cell + seed);
        vec2 center = cell + 0.5 + (rnd - 0.5) * 0.16;
        vec2 uv = clamp((inv * (center * CELL) - u_scroll) / u_view, 0.0, 1.0);
        float amount = dot(cmyk(texture2D(u_comp, uv).rgb), mask);
        vec2 rnd2 = hash22(cell + seed + 7.0);
        // Slightly under the area-true 0.564 to make up for the soft, spreading rim;
        // near full coverage the dots grow into each other, like a solid in print.
        float radius = 0.53 * sqrt(amount) * (0.88 + 0.24 * rnd2.x);
        radius = mix(radius, 0.7, smoothstep(0.8, 1.0, amount));
        float dist = length(v - center) * (1.0 + rough);
        float dot1 = 1.0 - smoothstep(radius - soft, radius + soft, dist);
        cover = max(cover, dot1 * (0.88 + 0.12 * rnd2.y));
      }
      return cover;
    }

    // The type plate: a fine 45 degree screen fed by the type layer. Full coverage grows the
    // dots into a near-solid with small gaps; edges break into dots.
    float typePlate(vec2 g) {
      mat2 rot = mat2(0.7071, 0.7071, -0.7071, 0.7071);
      mat2 inv = mat2(0.7071, -0.7071, 0.7071, 0.7071);
      vec2 v = rot * g / TYPE_CELL;
      vec2 base = floor(v);
      vec2 f = v - base;
      vec2 dir = vec2(f.x < 0.5 ? -1.0 : 1.0, f.y < 0.5 ? -1.0 : 1.0);
      float rough = (noise(g * 1.1 + 91.0) - 0.5) * 0.18;
      float soft = 0.05 + 1.0 / (TYPE_CELL * u_dpr);
      float cover = 0.0;
      for (int i = 0; i < 4; i++) {
        vec2 o = vec2((i == 1 || i == 3) ? dir.x : 0.0, i >= 2 ? dir.y : 0.0);
        vec2 cell = base + o;
        vec2 center = cell + 0.5 + (hash22(cell + 91.0) - 0.5) * 0.12;
        vec2 uv = clamp((inv * (center * TYPE_CELL) - u_scroll) / u_view, 0.0, 1.0);
        float amount = smoothstep(0.1, 0.6, texture2D(u_ink, uv).a);
        float radius = mix(0.56 * sqrt(amount), 0.68, smoothstep(0.8, 1.0, amount));
        float dist = length(v - center) * (1.0 + rough);
        cover = max(cover, 1.0 - smoothstep(radius - soft, radius + soft, dist));
      }
      return cover;
    }

    void main() {
      vec2 p = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y);
      // Document coordinates: screens, waves and grain travel with the page.
      vec2 q = p / u_dpr + u_scroll;

      // Fixed wave: square and triangle generators shift the screens in fields.
      vec2 w;
      w.x = sq(q.y * 0.011) * 2.2 + tri(q.y * 0.031 + q.x * 0.006) * 1.6;
      w.y = sq(q.x * 0.009 + 1.3) * 2.0 + tri(q.x * 0.027 + q.y * 0.005 + 0.7) * 1.4;

      // Each plate is slightly out of register.
      vec2 wc = w + vec2(0.5, 0.0) + vec2(tri(q.y * 0.050), tri(q.x * 0.050)) * 0.5;
      vec2 wm = w + vec2(-0.4, 0.4) + vec2(tri(q.y * 0.047 + 2.0), tri(q.x * 0.052 + 1.0)) * 0.5;
      vec2 wy = w + vec2(0.0, -0.5) + vec2(tri(q.y * 0.053 + 4.0), tri(q.x * 0.049 + 3.0)) * 0.5;

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

      // Type follows the same wave, at a third of its strength so letters stay whole.
      float type = typePlate(q + w * 0.35);
      col *= mix(vec3(1.0), BLACK, type * 0.96);

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
  for (const name of ["u_res", "u_view", "u_scroll", "u_dpr"]) {
    u[name] = gl.getUniformLocation(program, name);
  }

  function makeTexture(unit) {
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return tex;
  }
  const bgTexture = makeTexture(0);
  const inkTexture = makeTexture(1);
  gl.uniform1i(gl.getUniformLocation(program, "u_comp"), 0);
  gl.uniform1i(gl.getUniformLocation(program, "u_ink"), 1);

  // ---------- Layers: background tones and type coverage, both fed to the screen ----------

  // Background tones at half resolution, a few texels per dot.
  const SCALE = 0.5;
  const comp = document.createElement("canvas");
  const bctx = comp.getContext("2d");
  // Type layer at device resolution for the fine type screen: transparent, alpha is ink coverage.
  const inkComp = document.createElement("canvas");
  const ctx = inkComp.getContext("2d");
  let background = null;
  let glyphs = [];
  let ovals = [];
  let rules = [];
  let dirty = true;
  let paintedScroll = { x: -1, y: -1 };

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
        glyphs.push({ ch, x: r.left + sx, y: r.top + sy + ascent, scaleX, font, stretched, link });
      }
    }

    for (const el of page.querySelectorAll(".oval")) {
      const r = el.getBoundingClientRect();
      const width = parseFloat(getComputedStyle(el).borderTopWidth) || 0;
      ovals.push({ x: r.left + sx, y: r.top + sy, w: r.width, h: r.height, width, link: el.closest("a") });
    }

    for (const el of page.querySelectorAll("*")) {
      if (el.classList.contains("oval")) continue;
      const cs = getComputedStyle(el);
      const width = parseFloat(cs.borderBottomWidth) || 0;
      if (!width || cs.borderBottomStyle === "none") continue;
      const link = el.closest("a");
      for (const r of el.getClientRects()) {
        rules.push({ x: r.left + sx, y: r.bottom + sy - width, w: r.width, h: width, link });
      }
    }

    requestDraw(true);
  }

  function alphaFor(link) {
    return link && link.matches(":hover") ? 0.55 : 1;
  }

  function paint() {
    const sx = window.scrollX;
    const sy = window.scrollY;
    const b = SCALE;
    const bgW = Math.max(1, Math.round(viewW * b));
    const bgH = Math.max(1, Math.round(viewH * b));
    if (comp.width !== bgW || comp.height !== bgH) {
      comp.width = bgW;
      comp.height = bgH;
    }
    const k = dpr;
    const w = Math.max(1, Math.round(viewW * k));
    const h = Math.max(1, Math.round(viewH * k));
    if (inkComp.width !== w || inkComp.height !== h) {
      inkComp.width = w;
      inkComp.height = h;
    }

    // Background: covers the whole document and scrolls with it, like the CSS fallback.
    const docW = document.documentElement.clientWidth;
    const docH = Math.max(document.documentElement.scrollHeight, viewH);
    const scale = Math.max(docW / background.width, docH / background.height);
    const bw = background.width * scale;
    const bh = background.height * scale;
    bctx.setTransform(b, 0, 0, b, 0, 0);
    bctx.imageSmoothingQuality = "high";
    bctx.drawImage(background, (docW - bw) / 2 - sx, -sy, bw, bh);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#000";
    ctx.strokeStyle = "#000";

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
      ctx.setTransform(k * g.scaleX, 0, 0, k, k * (g.x - sx), k * y);
      ctx.fillText(g.ch, 0, 0);
    }
    ctx.setTransform(k, 0, 0, k, 0, 0);

    for (const o of ovals) {
      ctx.globalAlpha = alphaFor(o.link);
      ctx.lineWidth = o.width;
      ctx.beginPath();
      ctx.ellipse(o.x - sx + o.w / 2, o.y - sy + o.h / 2, Math.max(0, o.w / 2 - o.width / 2), Math.max(0, o.h / 2 - o.width / 2), 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    for (const r of rules) {
      ctx.globalAlpha = alphaFor(r.link);
      ctx.fillRect(r.x - sx, r.y - sy, r.w, r.h);
    }

    // Keyboard focus ring, since the real one is hidden under the canvas.
    const focused = document.activeElement;
    if (focused && page.contains(focused) && focused.matches(":focus-visible")) {
      const r = focused.getBoundingClientRect();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 2;
      ctx.strokeRect(r.left - 4, r.top - 4, r.width + 8, r.height + 8);
    }
    ctx.globalAlpha = 1;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, bgTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, comp);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, inkTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, inkComp);
    paintedScroll = { x: sx, y: sy };
  }

  // ---------- Drawing: static, only when the page changes ----------

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

  function draw() {
    if (dirty || window.scrollX !== paintedScroll.x || window.scrollY !== paintedScroll.y) {
      paint();
      dirty = false;
    }
    gl.uniform2f(u.u_res, canvas.width, canvas.height);
    gl.uniform2f(u.u_view, viewW, viewH);
    gl.uniform2f(u.u_scroll, paintedScroll.x, paintedScroll.y);
    gl.uniform1f(u.u_dpr, dpr);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  let active = false;
  let pending = false;
  function requestDraw(markDirty) {
    if (markDirty) dirty = true;
    if (!active || pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      if (active) draw();
    });
  }

  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    active = false;
    canvas.remove();
    document.documentElement.classList.remove("gl-on");
  });

  function begin() {
    document.body.append(canvas);
    active = true;
    resize();
    draw();
    // Hide the DOM's own ink only once the screened version is on screen.
    document.documentElement.classList.add("gl-on");

    window.addEventListener("resize", resize);
    window.addEventListener("scroll", () => requestDraw(false), { passive: true });
    document.fonts.addEventListener("loadingdone", collect);
    const markDirty = () => requestDraw(true);
    document.addEventListener("pointerover", markDirty, { passive: true });
    document.addEventListener("pointerout", markDirty, { passive: true });
    document.addEventListener("focusin", markDirty);
    document.addEventListener("focusout", markDirty);
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
