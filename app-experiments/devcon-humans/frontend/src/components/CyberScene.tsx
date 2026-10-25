"use client";

import { useEffect, useRef } from "react";
import { buildSignTextures, type Panel } from "@/lib/sign-canvas";
import { loadSignFaces } from "@/lib/sign-script";

/**
 * The night-street hero.
 *
 * A single AI plate is displaced by its depth map to give real 2.5D parallax,
 * then the procedurally generated signage is composited in the same pass so it
 * inherits that parallax exactly. Puddle reflections are sampled from the
 * mirrored scene, which is why they track the signs' own flicker for free.
 */

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  // Flip v so texture space matches image space: vUv.y == 0 is the top row,
  // which keeps the shader's horizon/reflection maths in plate coordinates.
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uPlate;
uniform sampler2D uDepth;
uniform sampler2D uSigns;
uniform sampler2D uPhase;
uniform sampler2D uWet;
uniform sampler2D uMachine;

uniform vec2  uOffset;
uniform vec2  uCover;
uniform float uStrength;
uniform float uZoom;
uniform float uTime;
uniform float uRain;
uniform float uSlant;
uniform float uRainSpeed;
uniform float uStreak;
uniform vec4  uMachineRect;

float hash11(float p) {
  return fract(sin(p * 78.233) * 43758.5453);
}

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// Mostly steady, with a slow breathe and occasional hard dropouts.
float flicker(float t, float ph) {
  float breathe = 0.95 + 0.05 * sin(t * 2.1 + ph * 31.0);
  float n = hash11(floor(t * 9.0) + ph * 57.0);
  float drop = n > 0.962 ? 0.45 : 1.0;
  float n2 = hash11(floor(t * 23.0) + ph * 13.0);
  drop *= n2 > 0.99 ? 0.7 : 1.0;
  return breathe * drop;
}

// One plane of falling rain at normalised depth L (1 at the camera, 0 at
// infinity). Column count, streak length and fall speed all derive from L, so a
// plane's drops project at the right size, spacing and pace for its distance:
// near planes give sparse long streaks, far planes dense short ones.
float rainPlane(vec2 uv, float t, float L, float slant, float speed, float streak, float seed) {
  float cols = 34.0 / L;
  // Subdividing far planes by a full 1/L made their streaks short dashes that
  // read as separate drops. Flattening the falloff keeps streaks long at depth.
  float rows = 0.85 / (0.40 + 0.60 * L);

  vec2 p = uv;
  p.x += p.y * slant;
  float x = p.x * cols + seed;
  float h = hash21(vec2(floor(x), seed));
  if (h < 0.30) return 0.0;                        // most, not all, columns carry drops
  float xw = smoothstep(0.5, 0.0, abs(fract(x) - 0.5) * 10.0);

  // Subtracting time moves the head downward in this v-down space, and the
  // bright band sits just before the wrap so the tail trails ABOVE the head.
  // Screen velocity, in fractions of viewport height per second. Writing the
  // time term as vel*rows makes vel the on-screen speed directly, independent
  // of how finely this plane is subdivided.
  //
  // True parallax would run near drops FASTER. This deliberately inverts that:
  // close rain reads better as slow heavy streaks than as a blur.
  float vel = speed * (1.0 - 0.60 * L);
  float y = fract(p.y * rows - t * vel * rows + h * 13.0);
  float amp = xw * (0.55 + 0.45 * fract(h * 31.0));

  // streak is the fraction of each cycle the tail covers. Near 1 the streaks
  // run together into continuous lines; lower it and each column empties
  // between drops, which reads as flecks blinking in and out.
  return smoothstep(1.0 - streak, 1.0, y) * amp;
}

// Rain as a volume rather than an overlay.
//
// Rain fills the air between the camera and whatever the pixel shows. A plane
// nearer than that surface is visible; one behind it is hidden by it. A distant
// pixel is therefore seen through many more planes than a near one, so the
// alley mouth and the street gather far more rain than the walls beside the
// camera - and every plane is displaced by the same parallax as the plate, so
// the curtain sits inside the scene instead of on top of it.
float rain(vec2 uv, float t, float sceneDepth, float slant, float speed, float streak, vec2 offset, float strength) {
  float acc = 0.0;
  for (int i = 0; i < 6; i++) {
    float L = mix(0.10, 0.95, float(i) / 5.0);
    float vis = smoothstep(sceneDepth - 0.06, sceneDepth + 0.06, L);
    if (vis <= 0.001) continue;
    vec2 puv = uv + (L - 0.5) * strength * offset;
    acc += rainPlane(puv, t, L, slant, speed, streak, float(i) * 37.0 + 1.0) * vis;
  }
  return acc;
}

void main() {
  // Cover-fit: shrink the sampled window so the plate always fills the
  // viewport. Multiplying crops into the image; dividing would sample past
  // its edges and letterbox.
  vec2 uv = (vUv - 0.5) * uCover / uZoom + 0.5;

  // Two refinement steps: sample depth, displace, resample. A cheap stand-in
  // for parallax occlusion mapping, enough to stop edges smearing.
  float d = texture(uDepth, uv).r;
  vec2 shift = (d - 0.5) * uStrength * uOffset;
  d = texture(uDepth, uv + shift * 0.5).r;
  shift = (d - 0.5) * uStrength * uOffset;
  vec2 suv = uv + shift;

  float ca = 0.0018 * length(vUv - 0.5);
  vec3 col;
  col.r = texture(uPlate, suv + vec2(ca, 0.0)).r;
  col.g = texture(uPlate, suv).g;
  col.b = texture(uPlate, suv - vec2(ca, 0.0)).b;

  // Per-panel flicker: R carries the phase, G the panel mask.
  vec2 pm = texture(uPhase, suv).rg;
  float f = flicker(uTime, pm.r);
  col *= mix(1.0, f, pm.g * 0.55);

  // Dark glyph cut-outs over the lit panel.
  vec4 gs = texture(uSigns, suv);
  col = mix(col, gs.rgb, gs.a);

  // --- Puddle reflection -------------------------------------------------
  // The wet mask carries the street's own shape in R and, in G, the ground
  // line for this column. Mirroring about a per-column horizon keeps the
  // reflection off the dry walls and clutter piled against them.
  vec2 wm = texture(uWet, suv).rg;
  float wet = wm.r;
  float hz = wm.g;
  if (wet > 0.004) {
    // Standing water is darker and smoother than dry asphalt, so the plate's
    // own tone says where puddles actually are. Without this the reflection
    // spreads evenly over the street and reads as a screen effect.
    float ground = max(max(col.r, col.g), col.b);
    float puddle = smoothstep(0.42, 0.08, ground);

    float below = max(suv.y - hz, 0.0);

    // Jittered taps up the mirrored column. Evenly spaced taps band visibly;
    // offsetting each by hashed noise smears them into wet-asphalt streaks.
    vec3 refl = vec3(0.0);
    float wsum = 0.0;
    for (int i = 0; i < 6; i++) {
      float k = float(i) / 5.0;
      float j = hash11(suv.x * 311.0 + float(i) * 17.0) - 0.5;
      vec2 ruv = vec2(
        suv.x + j * 0.013,
        hz - below * 1.65 - (k + j * 0.35) * 0.022
      );
      if (ruv.y <= 0.0) continue;
      vec3 sm = texture(uPlate, ruv).rgb;
      float lum = max(max(sm.r, sm.g), sm.b);
      // A soft ramp: a hard threshold quantises the plate's compression blocks
      // into visible steps once the reflection amplifies them.
      sm *= smoothstep(0.38, 1.05, lum);

      vec2 rpm = texture(uPhase, ruv).rg;
      sm *= mix(1.0, flicker(uTime, rpm.r), rpm.g * 0.8);

      vec4 rgs = texture(uSigns, ruv);            // glyphs occlude their reflection
      sm = mix(sm, sm * 0.12, rgs.a);

      float wgt = 1.0 - k * 0.55;                 // nearer taps dominate
      refl += sm * wgt;
      wsum += wgt;
    }
    refl /= max(wsum, 0.001);

    // Wet ground reads more saturated than the source, not less.
    float g = dot(refl, vec3(0.299, 0.587, 0.114));
    refl = mix(vec3(g), refl, 1.45);

    float edge = smoothstep(0.0, 0.035, below);
    col += max(refl, 0.0) * wet * edge * puddle * 1.05;
  }

  // --- Machine contact shadow --------------------------------------------
  // Soft dark pool under the base so the machine sits on the ground instead
  // of floating. Half an ellipse centred on the base line; drawn before the
  // machine composite so the body stays crisp on top of it.
  {
    float cx = (uMachineRect.x + uMachineRect.z) * 0.55;
    float halfW = (uMachineRect.z - uMachineRect.x) * 0.55;
    vec2 rel = vec2((vUv.x - cx) / (halfW * 2.45), (vUv.y - uMachineRect.w) / 0.12);
    float sh = 1.0 - smoothstep(0.15, 1.0, length(rel));
    col *= 1.0 - 0.7 * sh;
  }

  // --- Machine -------------------------------------------------------
  // Composited flat in screen space (vUv, not the depth-displaced suv) so it
  // sits static with no parallax. Drawn before atmosphere/rain so both still
  // fall on it like everything else in the scene.
  vec2 mUv = (vUv - uMachineRect.xy) / (uMachineRect.zw - uMachineRect.xy);
  if (mUv.x >= 0.0 && mUv.x <= 1.0 && mUv.y >= 0.0 && mUv.y <= 1.0) {
    vec4 mc = texture(uMachine, mUv);
    col = mix(col, mc.rgb, mc.a);
  }

  // --- Atmosphere --------------------------------------------------------
  float vig = 1.0 - 0.55 * pow(length((vUv - 0.5) * vec2(1.05, 1.25)), 2.4);
  col *= clamp(vig, 0.0, 1.0);

  float grain = (hash11(vUv.x * 1031.0 + vUv.y * 971.0 + floor(uTime * 24.0) * 7.0) - 0.5);
  float clum = max(max(col.r, col.g), col.b);
  col += grain * 0.026 * (1.0 - smoothstep(0.35, 0.9, clum));

  // Rain, thickening with distance, plus the veil heavy rain leaves down the
  // far end of the alley.
  //
  // A raindrop has no colour of its own - it is only visible because it catches
  // whatever light is around it. So the streaks are tinted by the pixel they
  // fall across and scaled by its brightness: near the neon they glow in that
  // sign's colour, and in deep shadow they nearly vanish. A fixed blue-white
  // is what made them read as pasted on.
  float illum = dot(col, vec3(0.299, 0.587, 0.114));
  vec3 hue = col / max(illum, 0.02);
  vec3 rainTint = mix(vec3(0.60, 0.72, 0.95), hue, 0.60);

  // A drop refracts light away from the eye, so against a lit surface it reads
  // as a dark streak rather than a highlight. Adding light instead made the
  // rain disappear into an already dark alley. Only a faint specular catch
  // survives, where there is strong light behind the drop.
  // Long pale streaks. The rain lifts toward a cool off-white rather than
  // darkening, and carries a little of whatever it falls across so it still
  // belongs to the scene. Its brightness follows the local light, so streaks
  // stay soft grey in shadow instead of glowing out of black.
  float rn = clamp(rain(vUv, uTime, d, uSlant, uRainSpeed, uStreak, uOffset, uStrength) * 0.55 * uRain, 0.0, 1.0);
  vec3 rainWhite = mix(vec3(0.86, 0.91, 1.00), hue, 0.22);
  col = mix(col, rainWhite * (0.30 + 0.70 * illum), rn * 0.45);

  float far = 1.0 - d;
  col += far * far * 0.05 * uRain * (0.25 + illum) * vec3(0.45, 0.58, 0.80);

  vec2 inside = step(vec2(0.0), suv) * step(suv, vec2(1.0));
  col *= inside.x * inside.y;

  outColor = vec4(col, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(sh) ?? "shader compile failed");
  }
  return sh;
}

function upload(gl: WebGL2RenderingContext, src: TexImageSource, unit: number) {
  const tex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return tex;
}

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = src;
  });

export default function CyberScene({
  plate,
  depth,
  wet,
  machine,
  machineHeight = 0.78,
  panels,
  plateW,
  plateH,
  strength = 0.08,
  rainIntensity = 8,
  rainSlant = 0,
  rainSpeed = 2.48,
  rainStreak = 0.9,
  className,
}: {
  plate: string;
  depth: string;
  wet: string;
  /** Optional foreground prop, composited flat (no parallax) so rain/atmosphere still fall on it. */
  machine?: string;
  /** Machine height as a fraction of the viewport height. */
  machineHeight?: number;
  panels: Panel[];
  plateW: number;
  plateH: number;
  strength?: number;
  /** Overall rain gain. 1 is the tuned default; raise for a downpour. */
  rainIntensity?: number;
  /** Streak lean. 0 is dead vertical; 0.05 would be a light wind. */
  rainSlant?: number;
  /** Fall speed in viewport heights per second, before the per-plane falloff. */
  rainSpeed?: number;
  /** Streak length as a fraction of its cycle. 0.9 is near-continuous lines; lower gives separated streaks. */
  rainStreak?: number;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
    if (!gl) return;

    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error(gl.getProgramInfoLog(prog));
      return;
    }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    const aPos = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const U = (n: string) => gl.getUniformLocation(prog, n);
    const u = {
      offset: U("uOffset"),
      cover: U("uCover"),
      strength: U("uStrength"),
      zoom: U("uZoom"),
      time: U("uTime"),
      rain: U("uRain"),
      slant: U("uSlant"),
      rainSpeed: U("uRainSpeed"),
      streak: U("uStreak"),
      machineRect: U("uMachineRect"),
    };

    const aspect = plateW / plateH;
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const target = { x: 0, y: 0 };
    const current = { x: 0, y: 0 };
    let raf = 0;
    let ready = false;
    let machineAspect = 0;
    const t0 = performance.now();

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
      const view = canvas.clientWidth / canvas.clientHeight;
      if (view > aspect) gl.uniform2f(u.cover, 1, aspect / view);
      else gl.uniform2f(u.cover, view / aspect, 1);

      // Machine rect in vUv space (0,0 = top-left, 1,1 = bottom-right),
      // bottom-anchored and centred, held to a fixed on-screen height.
      if (machineAspect > 0) {
        const hFrac = machineHeight * 0.6;
        const wFrac = (hFrac * canvas.height * machineAspect) / canvas.width;
        const x0 = 0.5 - wFrac / 2;
        const y0 = 1 - hFrac;
        gl.uniform4f(u.machineRect, x0, y0, x0 + wFrac, 1);
      }
    };

    const onPointer = (e: PointerEvent) => {
      target.x = (e.clientX / window.innerWidth) * 2 - 1;
      target.y = (e.clientY / window.innerHeight) * 2 - 1;
    };

    const frame = () => {
      raf = requestAnimationFrame(frame);
      if (!ready) return;
      current.x += (target.x - current.x) * 0.06;
      current.y += (target.y - current.y) * 0.06;
      resize();
      gl.uniform2f(u.offset, current.x, current.y);
      gl.uniform1f(u.strength, reduced ? 0 : strength);
      gl.uniform1f(u.zoom, 1.07);
      gl.uniform1f(u.time, (performance.now() - t0) / 1000);
      gl.uniform1f(u.rain, rainIntensity);
      gl.uniform1f(u.slant, rainSlant);
      gl.uniform1f(u.rainSpeed, rainSpeed);
      gl.uniform1f(u.streak, rainStreak);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    // Off-screen until (and unless) the machine texture loads, so the rect
    // check in the shader never matches.
    gl.uniform4f(u.machineRect, 2, 2, 3, 3);

    // The sign textures measure glyphs to fit them, so the faces have to be
    // loaded before the bake, not merely requested.
    Promise.all([
      loadImage(plate),
      loadImage(depth),
      loadImage(wet),
      machine ? loadImage(machine) : Promise.resolve(null),
      loadSignFaces(),
    ]).then(([plateImg, depthImg, wetImg, machineImg]) => {
      const { signs, phase } = buildSignTextures(panels, plateW, plateH);
      upload(gl, plateImg, 0);
      upload(gl, depthImg, 1);
      upload(gl, signs, 2);
      upload(gl, phase, 3);
      upload(gl, wetImg, 4);
      gl.uniform1i(U("uPlate"), 0);
      gl.uniform1i(U("uDepth"), 1);
      gl.uniform1i(U("uSigns"), 2);
      gl.uniform1i(U("uPhase"), 3);
      gl.uniform1i(U("uWet"), 4);
      if (machineImg) {
        upload(gl, machineImg, 5);
        gl.uniform1i(U("uMachine"), 5);
        machineAspect = machineImg.naturalWidth / machineImg.naturalHeight;
        resize();
      }
      ready = true;
      canvas.dataset.ready = "1";
    });

    window.addEventListener("pointermove", onPointer, { passive: true });
    window.addEventListener("resize", resize);
    resize();
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("resize", resize);
    };
  }, [
    plate,
    depth,
    wet,
    panels,
    plateW,
    plateH,
    strength,
    rainIntensity,
    rainSlant,
    rainSpeed,
    rainStreak,
  ]);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}
