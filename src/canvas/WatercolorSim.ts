// WatercolorSim — GPU three-field watercolor engine for paint-web.
// Shallow-water + fiber saturation + 8-channel suspended/deposited pigment
// after Curtis et al. 1997, with invasion-percolation capillary spread,
// evaporation-driven edge flow, curl-noise subgrid convection, granulation
// into paper valleys and Kubelka-Munk display compositing.
//
// Determinism: the sim clock advances one tick per step() call, so document
// replay (same op sequence) reproduces identical washes.

export interface WatercolorSplat {
  x: number; y: number; r: number; water: number;
  vx: number; vy: number;
}

export interface WatercolorStrokeInput {
  mode: 0 | 1 | 2; // 0 brush, 1 water, 2 lift
  water: number;
  splats: WatercolorSplat[];
  pig0: Float32Array; // 4 — suspended load, slots 0-3
  pig1: Float32Array; // 4 — slots 4-7
}

const MAXS = 48;

const VS = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main(){ vUv = aPos*0.5+0.5; gl_Position = vec4(aPos,0.,1.); }`;

const NOISE = `
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*0.1031); p3 += dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  float a=hash12(i), b=hash12(i+vec2(1,0)), c=hash12(i+vec2(0,1)), d=hash12(i+vec2(1,1));
  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y); }
float fbm(vec2 p){ float v=0., a=0.5; for(int i=0;i<5;i++){ v+=a*vnoise(p); p=p*2.03+17.1; a*=0.5; } return v; }`;

const PAPER_FS = `#version 300 es
precision highp float;
uniform float uGrainScale, uGrainAmp, uFineAmp, uFiberAmp, uSeed;
in vec2 vUv; out vec4 outP;
${NOISE}
void main(){
  vec2 p = gl_FragCoord.xy;
  float g     = fbm(p/uGrainScale + uSeed*11.3);
  float fine  = fbm(p/2.6 + uSeed*23.7);
  float fiber = fbm(vec2(p.x/46.0, p.y/3.4) + uSeed*31.1);
  float height = clamp(0.5 + (g-0.5)*uGrainAmp + (fine-0.5)*uFineAmp + (fiber-0.5)*uFiberAmp, 0.02, 0.98);
  float absorb = 0.78 + 0.5*(fbm(p/90.0 + uSeed*41.7)-0.5);
  float fiberN = fbm(p/6.0 + uSeed*53.9);
  float pore = fbm(vec2(p.x/7.0, p.y/2.4) + uSeed*7.7)*0.72 + fbm(p/1.6 + uSeed*67.3)*0.28;
  outP = vec4(height, absorb, fiberN, pore);
}`;

const WATER_FS = `#version 300 es
precision highp float;
const int MAXS = ${MAXS};
uniform sampler2D uWater, uPaper;
uniform vec2 uSize, uTilt;
uniform int uSplatCount, uMode;
uniform float uApplySplats;
uniform vec4 uSplat[MAXS];
uniform vec2 uSplatVel[MAXS];
uniform float uGrav,uDrag,uDragShallow,uMaxSpeed,uRelief,uEdgeFlow,uEdgeEvap,
              uAbsorb,uFill,uCap,uSeepT,uSeep,uEvap,uEvapS,uSplatOut,uFibers;
in vec2 vUv; out vec4 outW;
vec4 W(vec2 t){ return texture(uWater, t/uSize); }
float PH(vec2 t){ return texture(uPaper, t/uSize).r; }
float wetAt(vec2 t){ return smoothstep(0.0004, 0.004, W(t).r); }
void main(){
  vec2 t = gl_FragCoord.xy;
  vec4 w0 = W(t);
  float s = w0.a;
  vec2 back = t - w0.gb;
  vec4 wb = W(back);
  float h = wb.r;
  vec2 vel = wb.gb;
  float hl = (W(t+vec2(1,0)).r + W(t-vec2(1,0)).r + W(t+vec2(0,1)).r + W(t-vec2(0,1)).r)*0.25;
  h = mix(h, hl, 0.25);
  if (uApplySplats > 0.5) {
    for (int i=0;i<MAXS;i++){ if(i>=uSplatCount) break;
      vec4 sp = uSplat[i];
      float fall = smoothstep(sp.z, sp.z*0.25, distance(t, sp.xy));
      if (uMode == 2) { h *= 1.0 - 0.6*fall; s *= 1.0 - 0.30*fall; }
      else {
        h += fall*sp.w;
        vel += uSplatVel[i]*fall;
        vec2 rd = t - sp.xy;
        float rl = max(length(rd), 1e-3);
        vel += (rd/rl) * fall * uSplatOut * sp.w;
      }
    }
  }
  float hasW = smoothstep(0.0002, 0.002, h);
  float gx = (W(t+vec2(1,0)).r + PH(t+vec2(1,0))*uRelief) - (W(t-vec2(1,0)).r + PH(t-vec2(1,0))*uRelief);
  float gy = (W(t+vec2(0,1)).r + PH(t+vec2(0,1))*uRelief) - (W(t-vec2(0,1)).r + PH(t-vec2(0,1))*uRelief);
  vel += (-uGrav*vec2(gx,gy)*0.5 + uTilt) * hasW;
  vec2 sob = vec2(wetAt(t+vec2(1.7,0.)) - wetAt(t-vec2(1.7,0.)),
                  wetAt(t+vec2(0.,1.7)) - wetAt(t-vec2(0.,1.7)))*0.5;
  float em = length(sob);
  if (em > 1e-4) vel -= (sob/em) * em * uEdgeFlow * hasW;
  vel *= mix(uDragShallow, uDrag, clamp(h*6.0, 0.0, 1.0));
  float spd = length(vel);
  if (spd > uMaxSpeed) vel *= uMaxSpeed/spd;
  vec4 pap = texture(uPaper, vUv);
  float da = min(h, uAbsorb*pap.g*(1.0-s));
  h -= da; s += da*uFill;
  if (uFibers > 0.5) {
    float P = 0.26 + 0.48*pap.a;
    float sx = max(W(t+vec2(1,0)).a, W(t-vec2(1,0)).a);
    float sy = max(W(t+vec2(0,1)).a, W(t-vec2(0,1)).a);
    float sd = max(max(W(t+vec2(1,1)).a, W(t-vec2(1,-1)).a),
                   max(W(t-vec2(1,1)).a, W(t+vec2(1,-1)).a));
    float drive = max(sx, max(sy*0.55, sd*0.75)) * 0.994;
    float gate = smoothstep(P - 0.05, P + 0.03, drive);
    s += uCap*2.6 * max(drive - s, 0.0) * gate * (0.7 + 0.6*pap.b);
  } else {
    float sl = (W(t+vec2(1,0)).a + W(t-vec2(1,0)).a + W(t+vec2(0,1)).a + W(t-vec2(0,1)).a)*0.25;
    s += uCap*(sl - s)*(0.7 + 0.6*pap.b);
  }
  if (s > uSeepT && h < 0.0006) { float sb = uSeep*(s-uSeepT); h += sb; s -= sb; }
  h -= uEvap*(1.0 + uEdgeEvap*em*8.0);
  s = clamp(s - uEvapS*s, 0.0, 1.0);
  outW = vec4(clamp(h, 0.0, 1.6), vel, s);
}`;

const PIG_FS = `#version 300 es
precision highp float;
const int MAXS = ${MAXS};
uniform sampler2D uWater, uSusA, uSusB, uDepA, uDepB, uPaper;
uniform vec2 uSize;
uniform int uSplatCount, uMode;
uniform float uApplySplats, uStrokeWater;
uniform vec4 uSplat[MAXS];
uniform vec4 uPig0, uPig1;
uniform vec4 uStainA,uStainB,uGranA,uGranB,uDensA,uDensB;
uniform float uDepRate,uLiftBase,uDryDep,uCarry,uPigDiff,uGranStr,uDryEps,uTime,uSwirl,uFibers;
in vec2 vUv;
${NOISE}
vec2 curlN(vec2 p){
  vec2 q = p/46.0 + vec2(0.0, uTime*0.45);
  float e = 1.6;
  float n0 = fbm(q);
  float nx = fbm(q + vec2(e/46.0, 0.0));
  float ny = fbm(q + vec2(0.0, e/46.0));
  return vec2(ny - n0, n0 - nx) * (46.0/e) * 0.05;
}
layout(location=0) out vec4 oSusA;
layout(location=1) out vec4 oSusB;
layout(location=2) out vec4 oDepA;
layout(location=3) out vec4 oDepB;
vec4 SA(vec2 t){ return texture(uSusA, t/uSize); }
vec4 SB(vec2 t){ return texture(uSusB, t/uSize); }
void main(){
  vec2 t = gl_FragCoord.xy;
  vec4 w = texture(uWater, vUv);
  float h = w.r; vec2 vel = w.gb;
  float wet = smoothstep(0.0004, 0.004, h);
  vec2 velP = vel + curlN(t)*uSwirl*smoothstep(0.025, 0.28, h);
  if (uFibers > 0.5) {
    vec2 gs = vec2(texture(uWater, (t+vec2(1.5,0.))/uSize).a - texture(uWater, (t-vec2(1.5,0.))/uSize).a,
                   texture(uWater, (t+vec2(0.,1.5))/uSize).a - texture(uWater, (t-vec2(0.,1.5))/uSize).a);
    float gl2 = length(gs);
    float damp2 = smoothstep(0.2, 0.6, w.a);
    if (gl2 > 1e-4) velP += (-gs/gl2) * min(gl2*6.0, 1.0) * 1.05 * damp2 * (1.0 - wet*0.5);
  }
  vec2 back = t - velP;
  vec4 sA = SA(back), sB = SB(back);
  vec4 dA = texture(uDepA, vUv), dB = texture(uDepB, vUv);
  vec4 avA = (SA(t+vec2(1,0))+SA(t-vec2(1,0))+SA(t+vec2(0,1))+SA(t-vec2(0,1)))*0.25;
  vec4 avB = (SB(t+vec2(1,0))+SB(t-vec2(1,0))+SB(t+vec2(0,1))+SB(t-vec2(0,1)))*0.25;
  float wick = uFibers * smoothstep(0.3, 0.9, w.a) * 0.55;
  float diffF = clamp(uPigDiff*(0.35 + h*45.0), 0.0, 0.45)*max(wet, wick);
  vec4 diffA = clamp(diffF*(1.45 - uDensA), 0.0, 0.6);
  vec4 diffB = clamp(diffF*(1.45 - uDensB), 0.0, 0.6);
  sA = mix(sA, avA, diffA);
  sB = mix(sB, avB, diffB);
  vec4 pap = texture(uPaper, vUv);
  if (uApplySplats > 0.5) {
    for (int i=0;i<MAXS;i++){ if(i>=uSplatCount) break;
      vec4 sp = uSplat[i];
      float fall = smoothstep(sp.z, sp.z*0.25, distance(t, sp.xy));
      if (uMode == 0) {
        float db = uStrokeWater < 0.2
          ? smoothstep(0.40, 0.56, pap.r*0.8 + pap.b*0.2 + (uStrokeWater-0.2)*0.5)
          : 1.0;
        sA += fall*db*uPig0;
        sB += fall*db*uPig1;
      } else if (uMode == 2) {
        sA *= 1.0 - 0.9*fall;
        sB *= 1.0 - 0.9*fall;
        dA *= 1.0 - fall*0.55*(vec4(1.0)-uStainA);
        dB *= 1.0 - fall*0.55*(vec4(1.0)-uStainB);
      }
    }
  }
  float valley = (0.5 - pap.r)*2.0;
  float spd = length(vel);
  float settleGate = 0.035 + uDryDep*pow(1.0-wet, 1.6);
  settleGate *= 1.0 - 0.93*uFibers*smoothstep(0.2, 0.6, w.a)*(1.0 - wet);
  vec4 granFA = clamp(1.0 + uGranA*valley*uGranStr, 0.05, 2.5);
  vec4 granFB = clamp(1.0 + uGranB*valley*uGranStr, 0.05, 2.5);
  vec4 carryA = clamp(1.0 - spd*uCarry*(1.2-uDensA), 0.1, 1.0);
  vec4 carryB = clamp(1.0 - spd*uCarry*(1.2-uDensB), 0.1, 1.0);
  vec4 setA = clamp(uDepRate*(settleGate + uDensA*0.09*wet + uStainA*0.12*wet)*granFA*carryA, 0.0, 0.85);
  vec4 setB = clamp(uDepRate*(settleGate + uDensB*0.09*wet + uStainB*0.12*wet)*granFB*carryB, 0.0, 0.85);
  float liftDyn = wet*(0.25 + 0.75*clamp(spd*1.5, 0.0, 1.0));
  vec4 liftA = uLiftBase*liftDyn*(vec4(1.0)-uStainA);
  vec4 liftB = uLiftBase*liftDyn*(vec4(1.0)-uStainB);
  vec4 dltA = sA*setA - dA*liftA;
  vec4 dltB = sB*setB - dB*liftB;
  sA = max(sA - dltA, 0.0); dA = max(dA + dltA, 0.0);
  sB = max(sB - dltB, 0.0); dB = max(dB + dltB, 0.0);
  if (h <= uDryEps) { dA += sA; sA = vec4(0.0); dB += sB; sB = vec4(0.0); }
  oSusA = min(sA, 6.0); oSusB = min(sB, 6.0);
  oDepA = min(dA, 6.0); oDepB = min(dB, 6.0);
}`;

const DISPLAY_FS = `#version 300 es
precision highp float;
uniform sampler2D uWater, uSusA, uSusB, uDepA, uDepB, uPaper, uGround;
uniform vec2 uSize;
uniform vec3 uK[8], uS[8], uPaperTint;
uniform float uWetDark;
in vec2 vUv; out vec4 fragColor;
${NOISE}
vec3 cothv(vec3 x){ x = max(x, vec3(1e-4)); vec3 e = exp(-2.0*x); return (1.0+e)/(1.0-e); }
vec4 dl(vec4 d){ vec4 g = pow(max(d, vec4(0.0)), vec4(1.35)); return 2.2*g/(g + 3.0); }
void main(){
  vec4 sA = texture(uSusA, vUv), sB = texture(uSusB, vUv);
  vec4 dA = texture(uDepA, vUv), dB = texture(uDepB, vUv);
  vec4 tA = dl(dA + sA*0.85), tB = dl(dB + sB*0.85);
  float tot = dot(tA, vec4(1.0)) + dot(tB, vec4(1.0));
  vec4 pap = texture(uPaper, vUv);
  float hR = texture(uPaper, vUv+vec2(1.0,0.0)/uSize).r;
  float hU = texture(uPaper, vUv+vec2(0.0,1.0)/uSize).r;
  float shade = clamp(0.985 + 5.0*(-(hR-pap.r)*0.7 - (hU-pap.r)*0.7), 0.9, 1.05);
  float grain = hash12(gl_FragCoord.xy*0.71);
  vec3 Rg = uPaperTint * (shade + (grain-0.5)*0.02);
  vec4 w = texture(uWater, vUv);
  float wet = smoothstep(0.0004, 0.004, w.r);
  float damp = smoothstep(0.25, 0.9, w.a);
  float wetLook = max(wet, damp*0.85);
  Rg *= 1.0 - uWetDark*wetLook;
  vec3 G = texture(uGround, vUv).rgb;
  Rg *= G*G;
  vec3 R = Rg;
  if (tot > 1e-4) {
    vec3 K = vec3(0.0), S = vec3(0.0);
    K += tA.x*uK[0] + tA.y*uK[1] + tA.z*uK[2] + tA.w*uK[3];
    S += tA.x*uS[0] + tA.y*uS[1] + tA.z*uS[2] + tA.w*uS[3];
    K += tB.x*uK[4] + tB.y*uK[5] + tB.z*uK[6] + tB.w*uK[7];
    S += tB.x*uS[4] + tB.y*uS[5] + tB.z*uS[6] + tB.w*uS[7];
    S *= 1.0 - 0.5*wetLook;
    K *= 1.0 + 0.2*wetLook;
    S = max(S, vec3(1e-4));
    vec3 a = 1.0 + K/S;
    vec3 b = sqrt(max(a*a - 1.0, 1e-6));
    vec3 cth = cothv(b*S);
    R = (1.0 - Rg*(a - b*cth)) / (a - Rg + b*cth);
  }
  float cov = clamp(tot*1.5 + (1.0 - dot(G, vec3(0.3333)))*3.0, 0.0, 1.0);
  R = mix(R, 0.582*R / (1.0 - 0.4*R), cov);
  R += wet*0.018;
  // Layer transparency: pigment-free texels must stay transparent so a wash
  // layer composites over hand-drawn work instead of covering it with an
  // opaque sheet of simulated paper. Alpha follows pigment (+ faint wet veil).
  float aOut = clamp(tot*2.2 + wet*0.06, 0.0, 1.0);
  vec3 Rout = pow(clamp(R, vec3(0.0), vec3(1.0)), vec3(1.0/2.2));
  fragColor = vec4(Rout * aOut, aOut); // premultiplied (context is premultipliedAlpha:true)
}`;

const BAKE_FS = `#version 300 es
precision highp float;
uniform sampler2D uSusA, uSusB, uDepA, uDepB, uGround;
uniform vec3 uK[8], uS[8];
in vec2 vUv; out vec4 fragColor;
vec4 dl(vec4 d){ vec4 g = pow(max(d, vec4(0.0)), vec4(1.35)); return 2.2*g/(g + 3.0); }
void main(){
  vec4 tA = dl(texture(uDepA, vUv) + texture(uSusA, vUv));
  vec4 tB = dl(texture(uDepB, vUv) + texture(uSusB, vUv));
  vec3 G = texture(uGround, vUv).rgb;
  float tot = dot(tA, vec4(1.0)) + dot(tB, vec4(1.0));
  if (tot > 1e-5) {
    vec3 K = vec3(0.0), S = vec3(0.0);
    K += tA.x*uK[0] + tA.y*uK[1] + tA.z*uK[2] + tA.w*uK[3];
    S += tA.x*uS[0] + tA.y*uS[1] + tA.z*uS[2] + tA.w*uS[3];
    K += tB.x*uK[4] + tB.y*uK[5] + tB.z*uK[6] + tB.w*uK[7];
    S += tB.x*uS[4] + tB.y*uS[5] + tB.z*uS[6] + tB.w*uS[7];
    S = max(S, vec3(1e-4));
    vec3 a = 1.0 + K/S;
    vec3 b = sqrt(max(a*a - 1.0, 1e-6));
    vec3 x = min(b*S, vec3(20.0));
    G *= b / (a*sinh(x) + b*cosh(x));
  }
  fragColor = vec4(G, 1.0);
}`;

const PAPERS: Record<string, { grainScale: number; grainAmp: number; fineAmp: number; fiberAmp: number }> = {
  hot: { grainScale: 4.5, grainAmp: 0.2, fineAmp: 0.1, fiberAmp: 0.05 },
  cold: { grainScale: 9.0, grainAmp: 0.55, fineAmp: 0.18, fiberAmp: 0.1 },
  rough: { grainScale: 15.0, grainAmp: 0.85, fineAmp: 0.24, fiberAmp: 0.12 },
};

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error("watercolor shader: " + gl.getShaderInfoLog(s));
  }
  return s;
}

function program(gl: WebGL2RenderingContext, fsSrc: string) {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error("watercolor link: " + gl.getProgramInfoLog(p));
  }
  const uni: Record<string, WebGLUniformLocation | null> = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i)!;
    const base = info.name.replace(/\[0\]$/, "");
    uni[base] = gl.getUniformLocation(p, info.name);
  }
  return { p, uni };
}

function makeTex(gl: WebGL2RenderingContext, w: number, h: number): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, w, h);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

function makeFbo(gl: WebGL2RenderingContext, texes: WebGLTexture[]): WebGLFramebuffer {
  const f = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, f);
  texes.forEach((t, i) =>
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
  gl.drawBuffers(texes.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error("watercolor fbo incomplete");
  }
  return f;
}

export interface WatercolorParams {
  substeps: number;
  grav: number; drag: number; dragShallow: number; maxSpeed: number; relief: number;
  edgeFlow: number; edgeEvap: number; splatOut: number;
  absorb: number; fill: number; cap: number; seepT: number; seep: number;
  evap: number; evapS: number;
  depRate: number; liftBase: number; dryDep: number; carry: number;
  pigDiff: number; granStr: number; dryEps: number; swirl: number;
  wetDark: number;
  paperTint: [number, number, number];
}

export class WatercolorSim {
  readonly gl: WebGL2RenderingContext;
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly W: number;
  readonly H: number;
  p: WatercolorParams = {
    substeps: 2,
    grav: 0.45, drag: 0.96, dragShallow: 0.82, maxSpeed: 2.4, relief: 0.45,
    edgeFlow: 0.22, edgeEvap: 2.5, splatOut: 2.2,
    absorb: 0.016, fill: 1.3, cap: 0.1, seepT: 0.68, seep: 0.0025,
    evap: 0.00018, evapS: 0.00022,
    depRate: 0.02, liftBase: 0.028, dryDep: 9.0, carry: 0.35,
    pigDiff: 0.45, granStr: 1.0, dryEps: 0.00018, swirl: 1.6,
    wetDark: 0.12,
    paperTint: [0.93, 0.905, 0.845],
  };
  fibers = true;
  time = 0;

  private paperP: ReturnType<typeof program>;
  private waterP: ReturnType<typeof program>;
  private pigP: ReturnType<typeof program>;
  private dispP: ReturnType<typeof program>;
  private bakeP: ReturnType<typeof program>;
  private paperT: WebGLTexture;
  private water: WebGLTexture[];
  private waterF: WebGLFramebuffer[];
  private pig: { susA: WebGLTexture; susB: WebGLTexture; depA: WebGLTexture; depB: WebGLTexture }[];
  private pigF: WebGLFramebuffer[];
  private ground: WebGLTexture[];
  private groundF: WebGLFramebuffer[];
  private wCur = 0;
  private pCur = 0;
  private gCur = 0;
  private splatArr = new Float32Array(MAXS * 4);
  private splatVelArr = new Float32Array(MAXS * 2);
  private slotK = new Float32Array(24);
  private slotS = new Float32Array(24);
  private slotGran = new Float32Array(8);
  private slotStain = new Float32Array(8).fill(1);
  private slotDens = new Float32Array(8).fill(0.5);

  constructor(width: number, height: number) {
    const canvas: HTMLCanvasElement | OffscreenCanvas =
      typeof document !== "undefined"
        ? document.createElement("canvas")
        : new OffscreenCanvas(width, height);
    canvas.width = width;
    canvas.height = height;
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("WebGL2 unavailable — watercolor layer needs a WebGL2 browser");
    if (!gl.getExtension("EXT_color_buffer_float")) {
      throw new Error("float render targets unavailable — watercolor layer cannot run");
    }
    this.gl = gl;
    this.W = width;
    this.H = height;

    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    this.paperP = program(gl, PAPER_FS);
    this.waterP = program(gl, WATER_FS);
    this.pigP = program(gl, PIG_FS);
    this.dispP = program(gl, DISPLAY_FS);
    this.bakeP = program(gl, BAKE_FS);

    this.paperT = makeTex(gl, this.W, this.H);
    const paperF = makeFbo(gl, [this.paperT]);
    void paperF;
    this.water = [0, 1].map(() => makeTex(gl, this.W, this.H));
    this.waterF = this.water.map(t => makeFbo(gl, [t]));
    this.pig = [0, 1].map(() => ({
      susA: makeTex(gl, this.W, this.H),
      susB: makeTex(gl, this.W, this.H),
      depA: makeTex(gl, this.W, this.H),
      depB: makeTex(gl, this.W, this.H),
    }));
    this.pigF = this.pig.map(o => makeFbo(gl, [o.susA, o.susB, o.depA, o.depB]));
    this.ground = [0, 1].map(() => makeTex(gl, this.W, this.H));
    this.groundF = this.ground.map(t => makeFbo(gl, [t]));

    this.clearAll();
    this.setPaper("cold", 7.31);
  }

  private bindTex(unit: number, tex: WebGLTexture) {
    this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    this.gl.bindTexture(this.gl.TEXTURE_2D, tex);
  }

  clearAll(): void {
    const gl = this.gl;
    gl.clearColor(0, 0, 0, 0);
    for (const f of [...this.waterF, ...this.pigF]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.clearColor(1, 1, 1, 1);
    for (const f of this.groundF) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    this.time = 0;
  }

  setPaper(preset: string, seed = 7.31): void {
    const pp = PAPERS[preset] ?? PAPERS.cold;
    const gl = this.gl;
    gl.useProgram(this.paperP.p);
    gl.uniform1f(this.paperP.uni.uGrainScale, pp.grainScale);
    gl.uniform1f(this.paperP.uni.uGrainAmp, pp.grainAmp);
    gl.uniform1f(this.paperP.uni.uFineAmp, pp.fineAmp);
    gl.uniform1f(this.paperP.uni.uFiberAmp, pp.fiberAmp);
    gl.uniform1f(this.paperP.uni.uSeed, seed);
    gl.bindFramebuffer(gl.FRAMEBUFFER, makeFbo(gl, [this.paperT]));
    gl.viewport(0, 0, this.W, this.H);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Set the 8-slot pigment optics from a stroke mixture. */
  setSlots(slots: {
    K: Float32Array; S: Float32Array;
    gran: Float32Array; stain: Float32Array; dens: Float32Array;
  }): void {
    this.slotK.set(slots.K);
    this.slotS.set(slots.S);
    this.slotGran.set(slots.gran);
    this.slotStain.set(slots.stain);
    this.slotDens.set(slots.dens);
  }

  /** Advance the wash by one stroke event: apply splats, then substeps. */
  stroke(input: WatercolorStrokeInput): void {
    const n = Math.min(input.splats.length, MAXS);
    for (let i = 0; i < n; i++) {
      const s = input.splats[i];
      this.splatArr[i * 4] = s.x;
      this.splatArr[i * 4 + 1] = s.y;
      this.splatArr[i * 4 + 2] = s.r;
      this.splatArr[i * 4 + 3] = s.water;
      this.splatVelArr[i * 2] = s.vx;
      this.splatVelArr[i * 2 + 1] = s.vy;
    }
    for (let sub = 0; sub < this.p.substeps; sub++) {
      this.stepOnce(n, input, sub === 0);
    }
  }

  /** Evolve the wash with no new input (deterministic ticks). */
  step(frames = 1): void {
    for (let i = 0; i < frames; i++) {
      this.stepOnce(0, { mode: 0, water: 0.5, splats: [], pig0: new Float32Array(4), pig1: new Float32Array(4) }, false);
    }
  }

  private stepOnce(splatCount: number, input: WatercolorStrokeInput, applySplats: boolean): void {
    const gl = this.gl;
    const p = this.p;
    this.time++;
    const evapMul = 1;

    // water pass
    const wNxt = 1 - this.wCur;
    gl.useProgram(this.waterP.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.waterF[wNxt]);
    gl.viewport(0, 0, this.W, this.H);
    this.bindTex(0, this.water[this.wCur]);
    this.bindTex(1, this.paperT);
    gl.uniform1i(this.waterP.uni.uWater, 0);
    gl.uniform1i(this.waterP.uni.uPaper, 1);
    gl.uniform2f(this.waterP.uni.uSize, this.W, this.H);
    gl.uniform2f(this.waterP.uni.uTilt, 0, 0);
    gl.uniform1i(this.waterP.uni.uSplatCount, splatCount);
    gl.uniform1i(this.waterP.uni.uMode, input.mode);
    gl.uniform1f(this.waterP.uni.uApplySplats, applySplats ? 1 : 0);
    gl.uniform4fv(this.waterP.uni.uSplat, this.splatArr);
    gl.uniform2fv(this.waterP.uni.uSplatVel, this.splatVelArr);
    gl.uniform1f(this.waterP.uni.uGrav, p.grav);
    gl.uniform1f(this.waterP.uni.uDrag, p.drag);
    gl.uniform1f(this.waterP.uni.uDragShallow, p.dragShallow);
    gl.uniform1f(this.waterP.uni.uMaxSpeed, p.maxSpeed);
    gl.uniform1f(this.waterP.uni.uRelief, p.relief);
    gl.uniform1f(this.waterP.uni.uEdgeFlow, p.edgeFlow);
    gl.uniform1f(this.waterP.uni.uEdgeEvap, p.edgeEvap);
    gl.uniform1f(this.waterP.uni.uAbsorb, p.absorb);
    gl.uniform1f(this.waterP.uni.uFill, p.fill);
    gl.uniform1f(this.waterP.uni.uCap, p.cap);
    gl.uniform1f(this.waterP.uni.uSeepT, p.seepT);
    gl.uniform1f(this.waterP.uni.uSeep, p.seep);
    gl.uniform1f(this.waterP.uni.uSplatOut, p.splatOut);
    gl.uniform1f(this.waterP.uni.uEvap, p.evap * evapMul);
    gl.uniform1f(this.waterP.uni.uEvapS, p.evapS * evapMul);
    gl.uniform1f(this.waterP.uni.uFibers, this.fibers ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.wCur = wNxt;

    // pigment pass
    const pNxt = 1 - this.pCur;
    gl.useProgram(this.pigP.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pigF[pNxt]);
    this.bindTex(0, this.water[this.wCur]);
    this.bindTex(1, this.pig[this.pCur].susA);
    this.bindTex(2, this.pig[this.pCur].susB);
    this.bindTex(3, this.pig[this.pCur].depA);
    this.bindTex(4, this.pig[this.pCur].depB);
    this.bindTex(5, this.paperT);
    gl.uniform1i(this.pigP.uni.uWater, 0);
    gl.uniform1i(this.pigP.uni.uSusA, 1);
    gl.uniform1i(this.pigP.uni.uSusB, 2);
    gl.uniform1i(this.pigP.uni.uDepA, 3);
    gl.uniform1i(this.pigP.uni.uDepB, 4);
    gl.uniform1i(this.pigP.uni.uPaper, 5);
    gl.uniform2f(this.pigP.uni.uSize, this.W, this.H);
    gl.uniform1i(this.pigP.uni.uSplatCount, splatCount);
    gl.uniform1i(this.pigP.uni.uMode, input.mode);
    gl.uniform1f(this.pigP.uni.uApplySplats, applySplats ? 1 : 0);
    gl.uniform1f(this.pigP.uni.uStrokeWater, input.water);
    gl.uniform4fv(this.pigP.uni.uSplat, this.splatArr);
    gl.uniform4fv(this.pigP.uni.uPig0, input.pig0);
    gl.uniform4fv(this.pigP.uni.uPig1, input.pig1);
    gl.uniform4f(this.pigP.uni.uStainA, this.slotStain[0], this.slotStain[1], this.slotStain[2], this.slotStain[3]);
    gl.uniform4f(this.pigP.uni.uStainB, this.slotStain[4], this.slotStain[5], this.slotStain[6], this.slotStain[7]);
    gl.uniform4f(this.pigP.uni.uGranA, this.slotGran[0], this.slotGran[1], this.slotGran[2], this.slotGran[3]);
    gl.uniform4f(this.pigP.uni.uGranB, this.slotGran[4], this.slotGran[5], this.slotGran[6], this.slotGran[7]);
    gl.uniform4f(this.pigP.uni.uDensA, this.slotDens[0], this.slotDens[1], this.slotDens[2], this.slotDens[3]);
    gl.uniform4f(this.pigP.uni.uDensB, this.slotDens[4], this.slotDens[5], this.slotDens[6], this.slotDens[7]);
    gl.uniform1f(this.pigP.uni.uDepRate, p.depRate);
    gl.uniform1f(this.pigP.uni.uLiftBase, p.liftBase);
    gl.uniform1f(this.pigP.uni.uDryDep, p.dryDep);
    gl.uniform1f(this.pigP.uni.uCarry, p.carry);
    gl.uniform1f(this.pigP.uni.uPigDiff, p.pigDiff);
    gl.uniform1f(this.pigP.uni.uGranStr, p.granStr);
    gl.uniform1f(this.pigP.uni.uDryEps, p.dryEps);
    gl.uniform1f(this.pigP.uni.uTime, this.time);
    gl.uniform1f(this.pigP.uni.uSwirl, p.swirl);
    gl.uniform1f(this.pigP.uni.uFibers, this.fibers ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.pCur = pNxt;
  }

  /** Render the K-M composite onto the sim's GL canvas (source for 2D blit). */
  render(): void {
    const gl = this.gl;
    gl.useProgram(this.dispP.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.W, this.H);
    this.bindTex(0, this.water[this.wCur]);
    this.bindTex(1, this.pig[this.pCur].susA);
    this.bindTex(2, this.pig[this.pCur].susB);
    this.bindTex(3, this.pig[this.pCur].depA);
    this.bindTex(4, this.pig[this.pCur].depB);
    this.bindTex(5, this.paperT);
    this.bindTex(6, this.ground[this.gCur]);
    gl.uniform1i(this.dispP.uni.uWater, 0);
    gl.uniform1i(this.dispP.uni.uSusA, 1);
    gl.uniform1i(this.dispP.uni.uSusB, 2);
    gl.uniform1i(this.dispP.uni.uDepA, 3);
    gl.uniform1i(this.dispP.uni.uDepB, 4);
    gl.uniform1i(this.dispP.uni.uPaper, 5);
    gl.uniform1i(this.dispP.uni.uGround, 6);
    gl.uniform2f(this.dispP.uni.uSize, this.W, this.H);
    gl.uniform3fv(this.dispP.uni.uK, this.slotK);
    gl.uniform3fv(this.dispP.uni.uS, this.slotS);
    gl.uniform3fv(this.dispP.uni.uPaperTint, this.p.paperTint);
    gl.uniform1f(this.dispP.uni.uWetDark, this.p.wetDark);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Fix the current wash into the ground as a dried glaze, clear pigment. */
  bake(): void {
    const gl = this.gl;
    const gNxt = 1 - this.gCur;
    gl.useProgram(this.bakeP.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.groundF[gNxt]);
    gl.viewport(0, 0, this.W, this.H);
    this.bindTex(0, this.pig[this.pCur].susA);
    this.bindTex(1, this.pig[this.pCur].susB);
    this.bindTex(2, this.pig[this.pCur].depA);
    this.bindTex(3, this.pig[this.pCur].depB);
    this.bindTex(4, this.ground[this.gCur]);
    gl.uniform1i(this.bakeP.uni.uSusA, 0);
    gl.uniform1i(this.bakeP.uni.uSusB, 1);
    gl.uniform1i(this.bakeP.uni.uDepA, 2);
    gl.uniform1i(this.bakeP.uni.uDepB, 3);
    gl.uniform1i(this.bakeP.uni.uGround, 4);
    gl.uniform3fv(this.bakeP.uni.uK, this.slotK);
    gl.uniform3fv(this.bakeP.uni.uS, this.slotS);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.gCur = gNxt;
    gl.clearColor(0, 0, 0, 0);
    for (const f of this.pigF) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.clearColor(0, 0, 0, 0);
    for (const f of this.waterF) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
  }

  /** Read the field state at a point (0..1 coords, y from top). */
  probe(x: number, y: number): { h: number; sat: number; suspended: number; deposited: number } {
    const gl = this.gl;
    const px = Math.round(x * this.W);
    const py = Math.round((1 - y) * this.H);
    const buf = new Float32Array(4);
    const read = (fbo: WebGLFramebuffer, attachment: number) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.readBuffer(gl.COLOR_ATTACHMENT0 + attachment);
      gl.readPixels(px, py, 1, 1, gl.RGBA, gl.FLOAT, buf);
      return [...buf];
    };
    const w = read(this.waterF[this.wCur], 0);
    const sA = read(this.pigF[this.pCur], 0);
    const sB = read(this.pigF[this.pCur], 1);
    const dA = read(this.pigF[this.pCur], 2);
    const dB = read(this.pigF[this.pCur], 3);
    const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);
    return {
      h: +w[0].toFixed(5),
      sat: +w[3].toFixed(5),
      suspended: +(sum(sA) + sum(sB)).toFixed(5),
      deposited: +(sum(dA) + sum(dB)).toFixed(5),
    };
  }

  dispose(): void {
    const lose = this.gl.getExtension("WEBGL_lose_context");
    lose?.loseContext();
  }
}
