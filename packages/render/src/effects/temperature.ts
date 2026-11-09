import { numberOf, type EffectCode } from "./code.ts";

/** How far all the way to one side takes a channel, as a share of it. */
export const TEMPERATURE_REACH = 0.25;

/**
 * What 色温 does to each channel at a temperature and a tint, each from −1 to 1: warmer has more red
 * and less blue, a tint towards 1 more red and blue and less green. Part of the format.
 */
export function temperatureGains(
  temperature: number,
  tint: number,
): readonly [number, number, number] {
  const t = Math.min(Math.max(temperature, -1), 1) * TEMPERATURE_REACH;
  const m = Math.min(Math.max(tint, -1), 1) * TEMPERATURE_REACH;
  return [1 + t + m / 2, 1 - m, 1 - t + m / 2];
}

const VERTEX = `#version 300 es
in vec2 corner;
out vec2 uv;
void main() {
  uv = corner;
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

/**
 * Each channel times its gain. The colors stay premultiplied, which takes the gains just as well,
 * and no channel can go past how much of the pixel there is.
 */
const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D picture;
uniform vec3 gains;
in vec2 uv;
out vec4 color;
void main() {
  vec4 c = texture(picture, uv);
  color = vec4(min(c.rgb * gains, vec3(c.a)), c.a);
}`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("No shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) ?? "The shader did not compile");
  }
  return shader;
}

/**
 * 色温: each channel of the colors times a gain, see `temperatureGains`. The canvas has nothing for
 * one channel at a time, so it is a shader on WebGL 2.
 */
const temperature: EffectCode = (aq) => {
  const gl = aq.canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false });
  if (!gl) throw new Error("No WebGL 2");
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) ?? "The program did not link");
  }
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  const corner = gl.getAttribLocation(program, "corner");
  gl.enableVertexAttribArray(corner);
  gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  // The picture comes as the canvas has it: premultiplied, and with its first row at the top.
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  const gains = gl.getUniformLocation(program, "gains");
  aq.render(({ input, values, width, height }) => {
    gl.viewport(0, 0, width, height);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, input);
    gl.uniform3fv(
      gains,
      temperatureGains(numberOf(values, "temperature"), numberOf(values, "tint")),
    );
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  });
};

export default temperature;
