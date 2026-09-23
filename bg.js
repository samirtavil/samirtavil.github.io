// Print screen over the whole page: a fixed layer of paper with round holes. Everything
// underneath (background image and type) only shows through the dots, so it reads as one
// printed surface. Square/triangle waves shift the dot grid slowly (like Photoshop's Wave
// filter), and the pointer adds a soft ripple. Without WebGL the page simply shows unscreened.
(() => {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const canvas = document.createElement("canvas");
  canvas.className = "dot-screen";
  canvas.setAttribute("aria-hidden", "true");

  const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false });
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
    uniform vec2 u_res;
    uniform float u_dpr;
    uniform float u_time;
    uniform vec2 u_mouse;
    uniform float u_force;

    const float CELL = 3.0;
    const float RADIUS = 0.46;
    const vec3 PAPER = vec3(0.84, 0.863, 0.84);

    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    float tri(float x) { return asin(sin(x)) * 0.6366; }
    float sq(float x) { return sign(sin(x)); }

    void main() {
      vec2 p = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y);
      vec2 q = p / u_dpr;
      float t = u_time;

      vec2 w;
      w.x = sq(q.y * 0.011 + t * 0.20) * 2.2 + tri(q.y * 0.031 + q.x * 0.006 - t * 0.33) * 1.6;
      w.y = sq(q.x * 0.009 - t * 0.16) * 2.0 + tri(q.x * 0.027 + q.y * 0.005 + t * 0.27) * 1.4;

      vec2 d = q - u_mouse;
      float r = length(d);
      float falloff = exp(-(r * r) / (240.0 * 240.0));
      w += (d / max(r, 0.001)) * sin(r * 0.05 - t * 2.5) * 6.0 * falloff * u_force;

      // 45-degree screen, like the black plate in print.
      vec2 g = q + w;
      vec2 v = mat2(0.7071, 0.7071, -0.7071, 0.7071) * g / CELL;
      vec2 cell = floor(v);
      float radius = RADIUS + (hash(cell) - 0.5) * 0.1;
      float aa = 1.0 / (CELL * u_dpr);
      float hole = 1.0 - smoothstep(radius - aa, radius + aa, length(v - cell - 0.5));

      float paper = 1.0 - hole;
      gl_FragColor = vec4(PAPER * paper, paper);
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
  for (const name of ["u_res", "u_dpr", "u_time", "u_mouse", "u_force"]) {
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
    canvas.remove();
  });

  document.body.append(canvas);
  resize();

  if (reduceMotion) {
    draw(start);
    window.addEventListener("resize", () => { resize(); draw(start); });
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
  requestAnimationFrame(loop);
})();
