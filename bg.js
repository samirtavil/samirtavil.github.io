// Animated background, rebuilt from the Photoshop smart filters in the same order:
// color halftone -> add noise -> wave. The waves drift slowly and ripple around the pointer.
// If WebGL is unavailable, the static CSS background (body::before) stays visible.
(() => {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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
    uniform float u_time;
    uniform vec2 u_mouse;
    uniform float u_force;

    const float CELL = 2.4;

    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    float tri(float x) { return asin(sin(x)) * 0.6366; }
    float sq(float x) { return sign(sin(x)); }

    // Cover, anchored top like the CSS fallback, with a margin larger than the
    // maximum wave offset so nothing samples past the image edge.
    vec3 tone(vec2 g) {
      vec2 view = u_res / u_dpr;
      float margin = 26.0;
      vec2 area = view + 2.0 * margin;
      float scale = max(area.x / u_tex_size.x, area.y / u_tex_size.y);
      vec2 cover = u_tex_size * scale;
      vec2 offset = vec2((view.x - cover.x) * 0.5, -margin);
      vec3 c = texture2D(u_tex, clamp((g - offset) / cover, 0.0, 1.0)).rgb;
      // Lift the darks so the coloured foreground has room to stand out.
      return 1.0 - (1.0 - c) * 0.6;
    }

    // One channel of Photoshop's color halftone: a rotated grid of dots whose
    // size follows the channel's brightness at the dot's center.
    float halftone(vec2 g, float angle, vec3 channel) {
      float s = sin(angle);
      float c = cos(angle);
      vec2 v = mat2(c, s, -s, c) * g / CELL;
      vec2 center = floor(v) + 0.5;
      vec2 centerG = mat2(c, -s, s, c) * (center * CELL);
      // Dot area equals the channel value, so the average tone matches the image.
      float radius = sqrt(dot(tone(centerG), channel) / 3.14159);
      float aa = 1.0 / (CELL * u_dpr);
      return 1.0 - smoothstep(radius - aa, radius + aa, length(v - center));
    }

    void main() {
      vec2 p = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y);
      vec2 q = p / u_dpr;
      float t = u_time;

      // Wave: square and triangle generators shift the dots in fields, drifting slowly.
      vec2 w;
      w.x = sq(q.y * 0.011 + t * 0.20) * 2.2 + tri(q.y * 0.031 + q.x * 0.006 - t * 0.33) * 1.6;
      w.y = sq(q.x * 0.009 - t * 0.16) * 2.0 + tri(q.x * 0.027 + q.y * 0.005 + t * 0.27) * 1.4;

      vec2 d = q - u_mouse;
      float r = length(d);
      float falloff = exp(-(r * r) / (240.0 * 240.0));
      w += (d / max(r, 0.001)) * sin(r * 0.05 - t * 2.5) * 6.0 * falloff * u_force;

      vec2 g = q + w;

      vec3 dots = vec3(
        halftone(g, 1.885, vec3(1.0, 0.0, 0.0)),
        halftone(g, 2.827, vec3(0.0, 1.0, 0.0)),
        halftone(g, 1.571, vec3(0.0, 0.0, 1.0))
      );
      // Soften the dots against the plain tone so the texture stays calm behind text.
      vec3 col = mix(tone(g), dots, 0.6);

      // Add noise: fixed per spot, so it travels with the waves instead of flickering.
      vec2 cellPx = floor(g * u_dpr);
      col += (vec3(hash(cellPx), hash(cellPx + 17.1), hash(cellPx + 31.7)) - 0.5) * 0.08;

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
  for (const name of ["u_res", "u_tex_size", "u_dpr", "u_time", "u_mouse", "u_force"]) {
    u[name] = gl.getUniformLocation(program, name);
  }

  let dpr = 1;
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  const pointer = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  const smooth = { x: pointer.x, y: pointer.y };
  let present = false;
  let target = 0;
  let force = 0;

  function onMove(x, y) {
    pointer.x = x;
    pointer.y = y;
    present = true;
    target = 1;
  }

  const start = performance.now();

  function draw(now) {
    smooth.x += (pointer.x - smooth.x) * 0.12;
    smooth.y += (pointer.y - smooth.y) * 0.12;
    // Moving the pointer kicks the ripple up; resting over the page keeps a faint one.
    target += ((present ? 0.3 : 0) - target) * 0.03;
    force += (target - force) * 0.08;

    gl.uniform2f(u.u_res, canvas.width, canvas.height);
    gl.uniform1f(u.u_dpr, dpr);
    gl.uniform1f(u.u_time, (now - start) / 1000);
    gl.uniform2f(u.u_mouse, smooth.x, smooth.y);
    gl.uniform1f(u.u_force, force);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  let running = false;
  function loop(now) {
    if (!running) return;
    draw(now);
    requestAnimationFrame(loop);
  }

  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    running = false;
    canvas.classList.remove("is-ready");
  });

  const img = new Image();
  img.onload = () => {
    // The halftone needs the image's tones, not its pixel noise, so feed it a softened copy.
    const toneCanvas = document.createElement("canvas");
    toneCanvas.width = Math.round(img.naturalWidth / 3);
    toneCanvas.height = Math.round(img.naturalHeight / 3);
    const ctx = toneCanvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, toneCanvas.width, toneCanvas.height);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, toneCanvas);
    gl.uniform2f(u.u_tex_size, toneCanvas.width, toneCanvas.height);

    document.body.prepend(canvas);
    resize();

    if (reduceMotion) {
      // One still frame of the dot texture, no movement.
      draw(start);
      window.addEventListener("resize", () => { resize(); draw(start); });
      canvas.classList.add("is-ready");
      return;
    }

    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", (e) => onMove(e.clientX, e.clientY), { passive: true });
    window.addEventListener("touchmove", (e) => {
      const touch = e.touches[0];
      if (touch) onMove(touch.clientX, touch.clientY);
    }, { passive: true });
    document.documentElement.addEventListener("pointerleave", () => { present = false; });
    window.addEventListener("touchend", () => { present = false; }, { passive: true });

    running = true;
    requestAnimationFrame((now) => {
      loop(now);
      canvas.classList.add("is-ready");
    });
  };
  img.src = "img/background.webp";
})();
