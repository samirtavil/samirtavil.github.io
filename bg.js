// Animated background: the paper texture drifts in slow waves and ripples softly around the pointer.
// If WebGL or motion is unavailable, the static CSS background (body::before) stays visible.
(() => {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

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

    void main() {
      vec2 p = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y);
      vec2 q = p / u_dpr;
      float t = u_time;

      // Slow, low drift so the texture breathes without pulling focus.
      vec2 w;
      w.x = sin(q.y * 0.016 + t * 0.35) * 2.5 + sin(q.y * 0.043 + q.x * 0.010 - t * 0.55) * 1.2;
      w.y = cos(q.x * 0.014 + t * 0.28) * 2.5 + sin(q.x * 0.039 + q.y * 0.008 + t * 0.45) * 1.0;

      // Gentle ripple around the pointer.
      vec2 d = q - u_mouse;
      float r = length(d);
      float falloff = exp(-(r * r) / (240.0 * 240.0));
      w += (d / max(r, 0.001)) * sin(r * 0.05 - t * 2.5) * 6.0 * falloff * u_force;

      vec2 g = q + w;

      // Cover, anchored top like the CSS fallback, with a margin larger than the
      // maximum displacement so the waves never sample past the image edge.
      float margin = 26.0 * u_dpr;
      vec2 area = u_res + 2.0 * margin;
      float scale = max(area.x / u_tex_size.x, area.y / u_tex_size.y);
      vec2 cover = u_tex_size * scale;
      vec2 offset = vec2((u_res.x - cover.x) * 0.5, -margin);
      vec2 uv = (g * u_dpr - offset) / cover;

      gl_FragColor = texture2D(u_tex, clamp(uv, 0.0, 1.0));
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
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
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

  window.addEventListener("pointermove", (e) => onMove(e.clientX, e.clientY), { passive: true });
  window.addEventListener("touchmove", (e) => {
    const touch = e.touches[0];
    if (touch) onMove(touch.clientX, touch.clientY);
  }, { passive: true });
  document.documentElement.addEventListener("pointerleave", () => { present = false; });
  window.addEventListener("touchend", () => { present = false; }, { passive: true });

  let running = false;
  const start = performance.now();

  function frame(now) {
    if (!running) return;

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

    requestAnimationFrame(frame);
  }

  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    running = false;
    canvas.classList.remove("is-ready");
  });

  const img = new Image();
  img.onload = () => {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
    gl.uniform2f(u.u_tex_size, img.naturalWidth, img.naturalHeight);

    document.body.prepend(canvas);
    resize();
    window.addEventListener("resize", resize);

    running = true;
    requestAnimationFrame((now) => {
      frame(now);
      canvas.classList.add("is-ready");
    });
  };
  img.src = "img/background.webp";
})();
