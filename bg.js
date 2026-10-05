// Background printed as a static CMYK colour halftone, drawn once in WebGL behind the page.
// The image covers the viewport like the CSS fallback and is screened into cyan, magenta,
// yellow and black dot grids on paper (Photoshop's 108/162/90/45 degree angles), each dot
// taking one ink amount from its centre, with rough edges, ink spread and paper grain. A
// fixed wave shifts where the dots sample, like Photoshop's Wave filter. The canvas stays
// fixed, so the page's multiplied type moves over it while scrolling. Without WebGL the
// plain background image stays visible.
(() => {
  const canvas = document.createElement("canvas");
  canvas.className = "bg-canvas";
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
    uniform sampler2D u_tex;
    uniform vec2 u_res;
    uniform vec2 u_tex_size;
    uniform float u_dpr;
    // Dot pitch in CSS pixels: coarse on laptops, a bit finer on narrow phone screens.
    uniform float CELL;
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

    // Image colour at a point in CSS pixels: cover, anchored top, like the CSS fallback.
    vec3 image(vec2 g) {
      vec2 view = u_res / u_dpr;
      float scale = max(view.x / u_tex_size.x, view.y / u_tex_size.y);
      vec2 size = u_tex_size * scale;
      vec2 offset = vec2((view.x - size.x) * 0.5, 0.0);
      return texture2D(u_tex, clamp((g - offset) / size, 0.0, 1.0)).rgb;
    }

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
        float amount = dot(cmyk(image(inv * (center * CELL))), mask);
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

    void main() {
      vec2 p = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y);
      vec2 q = p / u_dpr;

      // Fixed wave: square and triangle generators shift the screens in fields.
      vec2 w;
      w.x = sq(q.y * 0.011) * 2.2 + tri(q.y * 0.031 + q.x * 0.006) * 1.6;
      w.y = sq(q.x * 0.009 + 1.3) * 2.0 + tri(q.x * 0.027 + q.y * 0.005 + 0.7) * 1.4;

      // Each plate is slightly out of register.
      vec2 wc = w + vec2(0.5, 0.0) + vec2(tri(q.y * 0.050), tri(q.x * 0.050)) * 0.5;
      vec2 wm = w + vec2(-0.4, 0.4) + vec2(tri(q.y * 0.047 + 2.0), tri(q.x * 0.052 + 1.0)) * 0.5;
      vec2 wy = w + vec2(0.0, -0.5) + vec2(tri(q.y * 0.053 + 4.0), tri(q.x * 0.049 + 3.0)) * 0.5;

      float c = ink(q + wc, 1.885, 0.0, vec4(1.0, 0.0, 0.0, 0.0));
      float m = ink(q + wm, 2.827, 17.0, vec4(0.0, 1.0, 0.0, 0.0));
      float y = ink(q + wy, 1.571, 41.0, vec4(0.0, 0.0, 1.0, 0.0));
      float k = ink(q + w, 0.785, 63.0, vec4(0.0, 0.0, 0.0, 1.0));

      float grain = hash22(floor(p)).x - 0.5;
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
  for (const name of ["u_res", "u_tex_size", "u_dpr", "CELL"]) {
    u[name] = gl.getUniformLocation(program, name);
  }

  let pending = false;
  function draw() {
    pending = false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(u.u_res, canvas.width, canvas.height);
    gl.uniform1f(u.u_dpr, dpr);
    gl.uniform1f(u.CELL, rect.width < 640 ? 5.0 : 7.0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function requestDraw() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(draw);
  }

  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    canvas.remove();
  });

  const img = new Image();
  img.onload = () => {
    // Soften the image a little so dots follow its tones rather than its pixel noise.
    const soft = document.createElement("canvas");
    soft.width = Math.round(img.naturalWidth / 4);
    soft.height = Math.round(img.naturalHeight / 4);
    const sctx = soft.getContext("2d");
    sctx.imageSmoothingQuality = "high";
    sctx.drawImage(img, 0, 0, soft.width, soft.height);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, soft);
    gl.uniform2f(u.u_tex_size, soft.width, soft.height);

    document.body.prepend(canvas);
    draw();
    window.addEventListener("resize", requestDraw);
  };
  img.src = "img/background.webp";
})();
