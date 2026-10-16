// WebGL renderer for SPL particle quads: DS texture repeat/mirror modes, vertex-color modulation, polygon alpha.
import type { Quad, TexMeta } from './spl';

const VS = `attribute vec2 a_pos; attribute vec2 a_uv; attribute vec4 a_col;
varying vec2 v_uv; varying vec4 v_col;
void main() { v_uv = a_uv; v_col = a_col; gl_Position = vec4(a_pos.x / 128.0 - 1.0, 1.0 - a_pos.y / 96.0, 0.0, 1.0); }`;
const FS = `precision mediump float; uniform sampler2D u_tex; varying vec2 v_uv; varying vec4 v_col;
void main() { vec4 t = texture2D(u_tex, v_uv); float a = t.a * v_col.a; gl_FragColor = vec4(t.rgb * v_col.rgb * a, a); }`;

export interface TextureSet { textures: WebGLTexture[] }

export class ParticleRenderer {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext;
  private buf: WebGLBuffer;
  private loc: { pos: number; uv: number; col: number };

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 256; this.canvas.height = 192;
    const gl = this.canvas.getContext('webgl', { antialias: false, preserveDrawingBuffer: true, premultipliedAlpha: true });
    if (!gl) throw new Error('WebGL unavailable');
    this.gl = gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src); gl.compileShader(s);
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    this.loc = { pos: gl.getAttribLocation(prog, 'a_pos'), uv: gl.getAttribLocation(prog, 'a_uv'), col: gl.getAttribLocation(prog, 'a_col') };
    this.buf = gl.createBuffer()!;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  /** One GL texture per SPA texture, cut from the extracted sheet, with the texture's own wrap modes. */
  upload(sheet: HTMLImageElement, metas: TexMeta[]): TextureSet {
    const gl = this.gl, c = document.createElement('canvas'), g = c.getContext('2d')!;
    const textures = metas.map(m => {
      c.width = m.w; c.height = m.h;
      g.clearRect(0, 0, m.w, m.h);
      g.drawImage(sheet, m.x, 0, m.w, m.h, 0, 0, m.w, m.h);
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
      const wrap = (bit: number) => (m.flip & bit ? gl.MIRRORED_REPEAT : m.repeat & bit ? gl.REPEAT : gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap(1));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap(2));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      return t;
    });
    return { textures };
  }

  free(set: TextureSet) { for (const t of set.textures) this.gl.deleteTexture(t); }

  /** Draws the quads of each particle system, in order, onto a cleared canvas. */
  render(batches: { quads: Quad[]; set: TextureSet }[]) {
    const gl = this.gl;
    gl.viewport(0, 0, 256, 192);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    const stride = 8 * 4;
    gl.enableVertexAttribArray(this.loc.pos); gl.vertexAttribPointer(this.loc.pos, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(this.loc.uv); gl.vertexAttribPointer(this.loc.uv, 2, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(this.loc.col); gl.vertexAttribPointer(this.loc.col, 4, gl.FLOAT, false, stride, 16);
    for (const { quads, set } of batches) {
      // Consecutive quads that share a texture go in one draw call; order is kept (no depth sort on DS translucency).
      for (let i = 0; i < quads.length;) {
        const tex = quads[i].tex;
        let j = i;
        while (j < quads.length && quads[j].tex === tex) j++;
        const data = new Float32Array((j - i) * 6 * 8);
        let o = 0;
        for (let k = i; k < j; k++) {
          const q = quads[k];
          for (const vi of [0, 1, 2, 0, 2, 3]) {
            data.set([q.x[vi], q.y[vi], q.u[vi], q.v[vi], q.rgb[0], q.rgb[1], q.rgb[2], q.alpha], o);
            o += 8;
          }
        }
        const t = set.textures[tex] ?? set.textures[0];
        if (t) {
          gl.bindTexture(gl.TEXTURE_2D, t);
          gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
          gl.drawArrays(gl.TRIANGLES, 0, (j - i) * 6);
        }
        i = j;
      }
    }
  }
}
