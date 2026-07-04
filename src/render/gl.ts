// WebGL2 plumbing for the tiled image viewer: context, shader program,
// tile textures (R32F, NEAREST — core WebGL2 does not filter float
// textures), and the 256×1 colormap LUT texture.
//
// All the visual math (stretch, scale limits, colormap) happens in the
// fragment shader so restyling is one frame, never a CPU re-render.

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
out vec2 v_uv;
void main() {
  vec2 img = u_rect.xy + a_pos * u_rect.zw;
  // FITS y+ is up; clip-space y+ is up too, so no flip anywhere.
  vec2 screen = (img - u_center) * u_scale;
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
uniform vec2 u_cb;          // colormap bias (0..1), contrast (>0)
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
  const aPos = gl.getAttribLocation(program, "a_pos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
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
      tex: uniform(gl, program, "u_tex"),
      lut: uniform(gl, program, "u_lut"),
      limits: uniform(gl, program, "u_limits"),
      cb: uniform(gl, program, "u_cb"),
      stretch: uniform(gl, program, "u_stretch"),
    },
  };
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
