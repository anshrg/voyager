// WebGL2 plumbing for the tiled image viewer: context, shader program,
// tile textures (R32F, NEAREST — core WebGL2 does not filter float
// textures), and the 256×1 colormap LUT texture.
//
// All the visual math (stretch, scale limits, colormap) happens in the
// fragment shader so restyling is one frame, never a CPU re-render.

import { MAX_BANDS } from "./trilogy";

export const STRETCHES = [
  "linear",
  "log",
  "sqrt",
  "squared",
  "asinh",
  "sinh",
  "power",
] as const;
export type Stretch = (typeof STRETCHES)[number];

const VERT = `#version 300 es
in vec2 a_pos;              // unit quad [0,1]^2
uniform vec4 u_rect;        // tile rect in image px: x0, y0, w, h
uniform vec2 u_center;      // view center in image px
uniform float u_scale;      // device px per image px
uniform vec2 u_viewport;    // canvas size in device px
uniform vec2 u_rot;         // view rotation (cos θ, sin θ), CCW in image y-up
out vec2 v_uv;
void main() {
  vec2 img = u_rect.xy + a_pos * u_rect.zw;
  // FITS y+ is up; clip-space y+ is up too, so no flip anywhere.
  vec2 d = img - u_center;
  // Rotate about the view center (WCS-align lock; identity when u_rot = (1,0)).
  vec2 rd = vec2(u_rot.x * d.x - u_rot.y * d.y, u_rot.y * d.x + u_rot.x * d.y);
  vec2 screen = rd * u_scale;
  gl_Position = vec4(screen / (0.5 * u_viewport), 0.0, 1.0);
  v_uv = a_pos;
}`;

// Stretch functions follow DS9's definitions (a = 1000 for log/power,
// asinh/sinh use the 10/3 scaling DS9 uses).
const FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_tex;    // R32F tile
uniform sampler2D u_lut;    // 256x1 RGBA8 colormap
uniform vec2 u_limits;      // lo, hi
uniform vec2 u_cb;          // colormap bias (-0.5..1.5), contrast (>0)
uniform int u_stretch;
in vec2 v_uv;
out vec4 outColor;

float stretchFn(float t) {
  const float a = 1000.0;
  if (u_stretch == 1) return log(a * t + 1.0) / log(a + 1.0);
  if (u_stretch == 2) return sqrt(t);
  if (u_stretch == 3) return t * t;
  if (u_stretch == 4) return asinh(10.0 * t) / asinh(10.0);
  if (u_stretch == 5) return sinh(3.0 * t) / sinh(3.0);
  if (u_stretch == 6) return (pow(a, t) - 1.0) / (a - 1.0);
  return t;
}

void main() {
  float v = texture(u_tex, v_uv).r;
  if (isnan(v)) {
    // Blank coverage (NaN / BLANK): near-black, distinct from LUT[0].
    outColor = vec4(0.045, 0.05, 0.06, 1.0);
    return;
  }
  float span = u_limits.y - u_limits.x;
  float t = clamp((v - u_limits.x) / (abs(span) < 1e-30 ? 1e-30 : span), 0.0, 1.0);
  t = stretchFn(t);
  // DS9-style colormap manipulation: bias slides the transfer window,
  // contrast steepens it (identity at bias 0.5, contrast 1).
  t = clamp(0.5 + (t - u_cb.x) * u_cb.y, 0.0, 1.0);
  outColor = texture(u_lut, vec2((t * 255.0 + 0.5) / 256.0, 0.5));
}`;

export interface TileProgram {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  lutTex: WebGLTexture;
  uniforms: {
    rect: WebGLUniformLocation;
    center: WebGLUniformLocation;
    scale: WebGLUniformLocation;
    viewport: WebGLUniformLocation;
    rot: WebGLUniformLocation;
    tex: WebGLUniformLocation;
    lut: WebGLUniformLocation;
    limits: WebGLUniformLocation;
    cb: WebGLUniformLocation;
    stretch: WebGLUniformLocation;
  };
}

function compile(gl: WebGL2RenderingContext, kind: number, src: string): WebGLShader {
  const shader = gl.createShader(kind);
  if (!shader) throw new Error("createShader failed");
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`shader compile: ${gl.getShaderInfoLog(shader) ?? "unknown"}`);
  }
  return shader;
}

function uniform(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  name: string,
): WebGLUniformLocation {
  const loc = gl.getUniformLocation(program, name);
  if (!loc) throw new Error(`missing uniform ${name}`);
  return loc;
}

export function createTileProgram(canvas: HTMLCanvasElement): TileProgram {
  const gl = canvas.getContext("webgl2", {
    antialias: false,
    depth: false,
    preserveDrawingBuffer: false,
  });
  if (!gl) throw new Error("WebGL2 unavailable");

  const program = gl.createProgram();
  if (!program) throw new Error("createProgram failed");
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
  // Pinned so the composite program can share this VAO.
  gl.bindAttribLocation(program, 0, "a_pos");
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`program link: ${gl.getProgramInfoLog(program) ?? "unknown"}`);
  }

  const vao = gl.createVertexArray();
  if (!vao) throw new Error("createVertexArray failed");
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
    gl.STATIC_DRAW,
  );
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  const lutTex = gl.createTexture();
  if (!lutTex) throw new Error("createTexture failed");
  gl.bindTexture(gl.TEXTURE_2D, lutTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  return {
    gl,
    program,
    vao,
    lutTex,
    uniforms: {
      rect: uniform(gl, program, "u_rect"),
      center: uniform(gl, program, "u_center"),
      scale: uniform(gl, program, "u_scale"),
      viewport: uniform(gl, program, "u_viewport"),
      rot: uniform(gl, program, "u_rot"),
      tex: uniform(gl, program, "u_tex"),
      lut: uniform(gl, program, "u_lut"),
      limits: uniform(gl, program, "u_limits"),
      cb: uniform(gl, program, "u_cb"),
      stretch: uniform(gl, program, "u_stretch"),
    },
  };
}

// ---- RGB composite program ------------------------------------------------
//
// N bands (≤ MAX_BANDS), each normalized over its own [lo, hi], stretched,
// then mixed into R/G/B by per-band weights. Covers both modes:
//   - simple RGB: 3 bands with pure R/G/B weights, shared limits, DS9 stretch;
//   - trilogy: N bands with rainbow/user weights, per-band trilogy levels and
//     the log curve with per-band softening k (u_stretch == 7).
// Ported from fitsgl tile.frag (u_mode 2), MIT, H. Akins. Transcribes
// trilogy.ts `compositePixel` exactly — keep the two in lockstep.
//
// Two ways to feed it the band values (one shared mixing body):
//   - "tile": co-gridded bands — the same tile of every band, sampled at the
//     same v_uv in one pass (the original path);
//   - "screen": bands on different grids — each band was first drawn through
//     its warp mesh into its own screen-sized R32F target (BAND_FRAG below),
//     and this pass reads those per screen pixel with texelFetch. Pixels a
//     band doesn't cover hold SENTINEL_OUTSIDE; its NaN pixels SENTINEL_BLANK.

/** Band-target value where the band has no pixel (cleared to this). */
export const SENTINEL_OUTSIDE = -3.0e38;
/** Band-target value for a NaN/blank band pixel. Real data never gets near. */
export const SENTINEL_BLANK = -2.0e38;

/** GLSL ES 3.00 forbids indexing a sampler array with a loop variable, so
 *  dispatch on literal indices (fitsgl's bandSamplerDispatch). */
function bandSamplerDispatch(screen: boolean): string {
  let body = "";
  for (let i = 0; i < MAX_BANDS; i++) {
    const read = screen ? `texelFetch(u_band[${i}], ivec2(gl_FragCoord.xy), 0).r` : `texture(u_band[${i}], v_uv).r`;
    body += `  if (idx == ${i}) return ${read};\n`;
  }
  return body;
}

function compositeFrag(screen: boolean): string {
  return `#version 300 es
precision highp float;
const int MAX_BANDS = ${MAX_BANDS};
uniform sampler2D u_band[MAX_BANDS];
uniform vec3 u_weight[MAX_BANDS];
uniform vec2 u_lim[MAX_BANDS];    // per-band lo, hi
uniform float u_k[MAX_BANDS];     // per-band trilogy softening
uniform int u_nBands;
uniform vec3 u_weightSum;         // host-precomputed Σ weights per channel
uniform int u_stretch;            // 0..6 DS9 stretches, 7 = trilogy
uniform float u_saturation;       // 1 = identity, 0 = grayscale
uniform vec2 u_cb;                // DS9 bias, contrast (applied per channel)
in vec2 v_uv;
out vec4 outColor;

float sampleBand(int idx) {
${bandSamplerDispatch(screen)}  return 0.0;
}

bool isOutside(float v) { return ${screen ? "v < -2.5e38" : "false"}; }
bool isBlank(float v) { return ${screen ? "v < -1.0e38" : "isnan(v)"}; }

float stretchFn(float t, float k) {
  const float a = 1000.0;
  if (u_stretch == 7) return k > 0.0 ? log(k * t + 1.0) / log(k + 1.0) : t;
  if (u_stretch == 1) return log(a * t + 1.0) / log(a + 1.0);
  if (u_stretch == 2) return sqrt(t);
  if (u_stretch == 3) return t * t;
  if (u_stretch == 4) return asinh(10.0 * t) / asinh(10.0);
  if (u_stretch == 5) return sinh(3.0 * t) / sinh(3.0);
  if (u_stretch == 6) return (pow(a, t) - 1.0) / (a - 1.0);
  return t;
}

void main() {
  vec3 num = vec3(0.0);
  int nanCount = 0;
  int outCount = 0;
  for (int i = 0; i < MAX_BANDS; i++) {
    if (i >= u_nBands) break;
    float v = sampleBand(i);
    if (isOutside(v)) { outCount++; continue; }
    if (isBlank(v)) { nanCount++; continue; }
    float span = u_lim[i].y - u_lim[i].x;
    float t = clamp((v - u_lim[i].x) / (abs(span) < 1e-30 ? 1e-30 : span), 0.0, 1.0);
    num += u_weight[i] * stretchFn(t, u_k[i]);
  }
  // No band covers this pixel: leave the background (as outside an image).
  if (outCount == u_nBands) discard;
  if (nanCount + outCount == u_nBands) {
    outColor = vec4(0.045, 0.05, 0.06, 1.0); // blank coverage, as single-band
    return;
  }
  vec3 rgb = clamp(vec3(
    u_weightSum.r > 0.0 ? num.r / u_weightSum.r : 0.0,
    u_weightSum.g > 0.0 ? num.g / u_weightSum.g : 0.0,
    u_weightSum.b > 0.0 ? num.b / u_weightSum.b : 0.0), 0.0, 1.0);
  if (u_saturation != 1.0) {
    float lum = (rgb.r + rgb.g + rgb.b) / 3.0;
    rgb = clamp(mix(vec3(lum), rgb, u_saturation), 0.0, 1.0);
  }
  rgb = clamp(0.5 + (rgb - u_cb.x) * u_cb.y, 0.0, 1.0);
  outColor = vec4(rgb, 1.0);
}`;
}

/** Full-viewport quad for the screen-mode composite pass. */
const SCREEN_VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0);
  v_uv = a_pos;
}`;

/** Mixing uniforms shared by both composite variants. */
export interface CompositeMixUniforms {
  bands: WebGLUniformLocation;
  weight: WebGLUniformLocation;
  lim: WebGLUniformLocation;
  k: WebGLUniformLocation;
  nBands: WebGLUniformLocation;
  weightSum: WebGLUniformLocation;
  stretch: WebGLUniformLocation;
  saturation: WebGLUniformLocation;
  cb: WebGLUniformLocation;
}

export interface CompositeProgram {
  program: WebGLProgram;
  /** View transform — tile variant only (the screen variant has none). */
  view: {
    rect: WebGLUniformLocation;
    center: WebGLUniformLocation;
    scale: WebGLUniformLocation;
    viewport: WebGLUniformLocation;
    rot: WebGLUniformLocation;
  } | null;
  uniforms: CompositeMixUniforms;
}

function link(gl: WebGL2RenderingContext, vert: string, frag: string, attribs: string[], what: string): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error("createProgram failed");
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vert));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, frag));
  attribs.forEach((a, i) => gl.bindAttribLocation(program, i, a));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`${what} link: ${gl.getProgramInfoLog(program) ?? "unknown"}`);
  }
  return program;
}

/** Compile a composite program into an existing tile program's context
 *  (shares its unit-quad VAO via the pinned a_pos location). Built lazily —
 *  only frames that actually show a composite pay for it. */
export function createCompositeProgram(gl: WebGL2RenderingContext, mode: "tile" | "screen" = "tile"): CompositeProgram {
  const screen = mode === "screen";
  const program = link(gl, screen ? SCREEN_VERT : VERT, compositeFrag(screen), ["a_pos"], `composite (${mode})`);
  const u = (name: string): WebGLUniformLocation => uniform(gl, program, name);
  return {
    program,
    view: screen
      ? null
      : { rect: u("u_rect"), center: u("u_center"), scale: u("u_scale"), viewport: u("u_viewport"), rot: u("u_rot") },
    uniforms: {
      bands: u("u_band[0]"),
      weight: u("u_weight[0]"),
      lim: u("u_lim[0]"),
      k: u("u_k[0]"),
      nBands: u("u_nBands"),
      weightSum: u("u_weightSum"),
      stretch: u("u_stretch"),
      saturation: u("u_saturation"),
      cb: u("u_cb"),
    },
  };
}

// ---- Warped band pass (bands on another pixel grid) -----------------------
//
// Draws one band's native tiles as warp meshes (vertices already in reference
// pixel coordinates, see warp.ts tileMesh) into that band's screen-sized
// R32F target, raw values only — the stretch/mix happens in the screen-mode
// composite pass, so the math is the exact same code as the co-gridded path.
// NEAREST sampling: a coarser band shows its own pixels as blocks.

const MESH_VERT = `#version 300 es
in vec2 a_ref;              // reference-grid draw coords (FITS 0-based + 0.5)
in vec2 a_uv;               // tile texture coords
uniform vec2 u_center;
uniform float u_scale;
uniform vec2 u_viewport;
uniform vec2 u_rot;
out vec2 v_uv;
void main() {
  vec2 d = a_ref - u_center;
  vec2 rd = vec2(u_rot.x * d.x - u_rot.y * d.y, u_rot.y * d.x + u_rot.x * d.y);
  gl_Position = vec4(rd * u_scale / (0.5 * u_viewport), 0.0, 1.0);
  v_uv = a_uv;
}`;

const BAND_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
in vec2 v_uv;
out vec4 outColor;
void main() {
  float v = texture(u_tex, v_uv).r;
  // NaN → blank sentinel; -inf clamps above the sentinels (reads as "low").
  outColor = vec4(isnan(v) ? -2.0e38 : max(v, -1.0e37), 0.0, 0.0, 1.0);
}`;

export interface WarpProgram {
  program: WebGLProgram;
  /** Mesh VAO: a_ref (0) + a_uv (1) interleaved in `vbo`, indices in `ibo`. */
  vao: WebGLVertexArrayObject;
  vbo: WebGLBuffer;
  indexCount: number;
  /** Render target for the band passes (attachment swapped per band). */
  fbo: WebGLFramebuffer;
  uniforms: {
    center: WebGLUniformLocation;
    scale: WebGLUniformLocation;
    viewport: WebGLUniformLocation;
    rot: WebGLUniformLocation;
    tex: WebGLUniformLocation;
  };
}

/** Build the warped-band pass, or throw when float render targets are
 *  unavailable (EXT_color_buffer_float — present on Apple GPUs). */
export function createWarpProgram(gl: WebGL2RenderingContext, indices: Uint16Array): WarpProgram {
  if (!gl.getExtension("EXT_color_buffer_float")) {
    throw new Error("this GPU can't render to float targets (EXT_color_buffer_float) — reprojected RGB unavailable");
  }
  const program = link(gl, MESH_VERT, BAND_FRAG, ["a_ref", "a_uv"], "warp band");
  const vao = gl.createVertexArray();
  const vbo = gl.createBuffer();
  const ibo = gl.createBuffer();
  const fbo = gl.createFramebuffer();
  if (!vao || !vbo || !ibo || !fbo) throw new Error("warp GL resources failed");
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  const u = (name: string): WebGLUniformLocation => uniform(gl, program, name);
  return {
    program,
    vao,
    vbo,
    indexCount: indices.length,
    fbo,
    uniforms: { center: u("u_center"), scale: u("u_scale"), viewport: u("u_viewport"), rot: u("u_rot"), tex: u("u_tex") },
  };
}

/** A screen-sized R32F band target (NEAREST; read back with texelFetch). */
export function createBandTarget(gl: WebGL2RenderingContext, w: number, h: number): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error("createTexture failed");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, w, h);
  return tex;
}

/** Upload a 256-entry RGB LUT into the shared colormap texture. */
export function uploadLut(p: TileProgram, rgb: Uint8Array): void {
  const { gl } = p;
  const rgba = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    rgba[i * 4] = rgb[i * 3];
    rgba[i * 4 + 1] = rgb[i * 3 + 1];
    rgba[i * 4 + 2] = rgb[i * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }
  gl.bindTexture(gl.TEXTURE_2D, p.lutTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
}

/** Create an R32F NEAREST tile texture from f32 pixel data. */
export function createTileTexture(
  gl: WebGL2RenderingContext,
  w: number,
  h: number,
  data: Float32Array,
): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error("createTexture failed");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, w, h, 0, gl.RED, gl.FLOAT, data);
  return tex;
}
