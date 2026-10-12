import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Shared wind state. One object per world; every wind-aware material points at
// the same uniform objects, so grass, trees and particles all sway in phase.
//   uWind = (dirX, dirZ, strength, unused)
// ---------------------------------------------------------------------------
export function createWind(angle, strength) {
  return {
    uTime: { value: 0 },
    uWind: { value: new THREE.Vector4(Math.cos(angle), Math.sin(angle), strength, 0) },
  };
}

// The same gust function is used by grass and props so waves travel coherently.
export const WIND_GLSL = /* glsl */ `
  float gustAt(vec2 p, vec2 dir, float t) {
    float ph = dot(p, dir) * 0.07 - t * 1.3;
    return sin(ph) * 0.5 + sin(ph * 0.37 + p.x * 0.021 - p.y * 0.017 + t * 0.4) * 0.5;
  }
`;

const NOISE_GLSL = /* glsl */ `
  float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float hash31(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  float fbm(vec2 p) {
    float s = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) {
      s += a * vnoise(p);
      p = p * 2.03 + vec2(17.0, 9.0);
      a *= 0.5;
    }
    return s;
  }
`;


/**
 * Baked terrain: vertex colours + fog, plus a fragment-level "detail" layer
 * (fine grain and optional wind ripples) so big flat triangles do not look flat.
 *   detail = { grain, ripple, dirX, dirZ }
 */
export function makeTerrainMaterial(detail = { grain: 0.15, ripple: 0, dirX: 1, dirZ: 0 }) {
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true });
  const u = { value: new THREE.Vector4(detail.grain, detail.ripple, detail.dirX, detail.dirZ) };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDetail = u;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWP = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vWP;
        uniform vec4 uDetail;
        ${NOISE_GLSL}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          float fade = 1.0 - smoothstep(25.0, 85.0, distance(vWP.xz, cameraPosition.xz));
          float g = vnoise(vWP.xz * 1.9) * 0.55 + vnoise(vWP.xz * 6.1) * 0.45;
          float u = dot(vWP.xz, uDetail.zw);
          float rp = sin(u * 2.7 + vnoise(vWP.xz * 0.3) * 8.0);
          float k = 1.0 + ((g - 0.5) * uDetail.x + rp * uDetail.y) * fade;
          diffuseColor.rgb *= k;
        }`,
      );
  };
  mat.customProgramCacheKey = () => 'terrain-detail';
  return mat;
}

/** Baked props (trees, rocks, doors) with optional wind sway via the aSway attribute. */
export function makePropMaterial(wind = null, { side = THREE.FrontSide } = {}) {
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side });
  if (wind) {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = wind.uTime;
      shader.uniforms.uWind = wind.uWind;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          attribute float aSway;
          uniform float uTime;
          uniform vec4 uWind;
          ${WIND_GLSL}`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          {
            float g = gustAt(position.xz, uWind.xy, uTime);
            float st = uWind.z * (0.55 + 0.45 * g);
            float flut = sin(uTime * 2.3 + position.x * 1.7 + position.z * 1.3) * 0.05 * uWind.z;
            transformed.xz += uWind.xy * (st + flut) * aSway;
          }`,
        );
    };
    mat.customProgramCacheKey = () => 'prop-wind';
  }
  return mat;
}

// ---------------------------------------------------------------------------
// Grass: instanced blades bent entirely on the GPU.
// ---------------------------------------------------------------------------
let bladeBase = null;
export function getBladeGeometry() {
  if (bladeBase) return bladeBase;
  // 7 vertices, 5 triangles; x is width (-0.5..0.5), y is 0..1 height.
  const pos = new Float32Array([
    -0.5, 0, 0, 0.5, 0, 0,
    -0.38, 0.35, 0, 0.38, 0.35, 0,
    -0.2, 0.7, 0, 0.2, 0.7, 0,
    0, 1, 0,
  ]);
  const idx = [0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4, 4, 5, 6];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  bladeBase = g;
  return g;
}

export function makeGrassMaterial(wind, { baseMul, tipMul, fadeNear = 55, fadeFar = 105 }) {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    fog: true,
    uniforms: {
      ...THREE.UniformsLib.fog,
      uTime: wind.uTime,
      uWind: wind.uWind,
      uBaseMul: { value: new THREE.Color(...baseMul) },
      uTipMul: { value: new THREE.Color(...tipMul) },
      uFade: { value: new THREE.Vector2(fadeNear, fadeFar) },
    },
    vertexShader: /* glsl */ `
      attribute vec3 aOff;
      attribute vec4 aParam;   // yaw, height, width, random
      attribute vec3 aTint;
      uniform float uTime;
      uniform vec4 uWind;
      uniform vec3 uBaseMul;
      uniform vec3 uTipMul;
      uniform vec2 uFade;
      varying vec3 vColor;
      #include <fog_pars_vertex>
      ${WIND_GLSL}
      void main() {
        float t = position.y;
        float yaw = aParam.x;
        float h = aParam.y;
        float w = aParam.z;
        float r = aParam.w;
        float d = distance(aOff.xz, cameraPosition.xz);
        h *= 1.0 - smoothstep(uFade.x, uFade.y, d);
        // blade in local space, with a little built-in curl
        float curl = (r - 0.5) * 0.7 * t * t * h;
        vec3 p = vec3(position.x * w, t * h, curl);
        float c = cos(yaw);
        float s = sin(yaw);
        p = vec3(p.x * c + p.z * s, p.y, -p.x * s + p.z * c);
        // wind
        float g = gustAt(aOff.xz, uWind.xy, uTime);
        float st = uWind.z * (0.55 + 0.45 * g);
        float flut = sin(uTime * 3.1 + r * 40.0 + aOff.x * 0.9) * 0.07 * (0.4 + uWind.z);
        float bend = (st + flut) * t * t * h * 0.85;
        p.xz += uWind.xy * bend;
        p.y -= bend * bend * 0.35 / max(h, 0.05);
        vec3 world = aOff + p;
        vec4 mvPosition = viewMatrix * vec4(world, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        vec3 base = aTint * uBaseMul;
        vec3 tip = aTint * uTipMul;
        float sheen = 0.92 + 0.18 * g * uWind.z;
        // slow, large-scale patchiness so a meadow is never one flat green
        float macro = 0.5 + 0.5 * sin(aOff.x * 0.043 + sin(aOff.z * 0.021) * 2.0) * sin(aOff.z * 0.037 - aOff.x * 0.019);
        vColor = mix(base, tip, smoothstep(0.0, 1.0, t)) * (0.86 + 0.28 * r) * sheen * (0.84 + 0.3 * macro);
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      #include <fog_pars_fragment>
      void main() {
        gl_FragColor = vec4(vColor, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }
    `,
  });
}

// ---------------------------------------------------------------------------
// Sky dome: gradient, sun/moon, stars, drifting clouds, optional cloud sea.
// ---------------------------------------------------------------------------
export function makeSkyMaterial(cfg) {
  const c = (v) => new THREE.Color(v);
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    uniforms: {
      uTime: { value: 0 },
      uZenith: { value: c(cfg.zenith) },
      uHorizon: { value: c(cfg.horizon) },
      uSunDir: { value: new THREE.Vector3(...cfg.sunDir).normalize() },
      uSunColor: { value: c(cfg.sunColor) },
      uCloudLight: { value: c(cfg.cloudLight) },
      uCloudDark: { value: c(cfg.cloudDark) },
      uCover: { value: cfg.cover },
      uSunSize: { value: cfg.sunSize ?? 0.9993 },
      uSunGlow: { value: cfg.sunGlow ?? 1 },
      uStars: { value: cfg.stars ?? 0 },
      uWind: { value: new THREE.Vector2(cfg.windX ?? 1, cfg.windZ ?? 0.3) },
      uSeaY: { value: cfg.seaY ?? -1e6 },
      uCam: { value: new THREE.Vector3() },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww; // always at the far plane
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime, uCover, uSunSize, uSunGlow, uStars, uSeaY;
      uniform vec3 uZenith, uHorizon, uSunDir, uSunColor, uCloudLight, uCloudDark, uCam;
      uniform vec2 uWind;
      varying vec3 vDir;
      ${NOISE_GLSL}
      vec3 stars(vec3 d) {
        vec3 p = d * 190.0;
        vec3 id = floor(p);
        vec3 f = fract(p) - 0.5;
        float h = hash31(id);
        float tw = 0.7 + 0.3 * sin(uTime * (1.0 + h * 3.0) + h * 40.0);
        return vec3(step(0.987, h) * smoothstep(0.5, 0.05, length(f)) * tw) * vec3(0.9, 0.95, 1.1);
      }
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        float sd = max(dot(d, uSunDir), 0.0);
        vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.5));
        col += uSunColor * (pow(sd, 5.0) * 0.14 + pow(sd, 40.0) * 0.32 * uSunGlow);
        if (uStars > 0.0 && h > 0.0) col += stars(d) * uStars * smoothstep(0.0, 0.2, h);
        col = mix(col, uSunColor * 1.7, smoothstep(uSunSize, uSunSize + 0.0005, sd));
        if (h > 0.0) {
          vec2 uv = d.xz / (h + 0.14) * 0.5 + uWind * uTime * 0.01;
          float n = fbm(uv * 1.7);
          float cov = smoothstep(1.0 - uCover, 1.0 - uCover + 0.25, n);
          float n2 = fbm((uv + uSunDir.xz * 0.05) * 1.7);
          float lit = clamp(0.5 + (n - n2) * 5.0, 0.0, 1.0);
          vec3 cc = mix(uCloudDark, uCloudLight, lit);
          cc += uSunColor * pow(sd, 6.0) * 0.18;
          col = mix(col, cc, cov * smoothstep(0.0, 0.16, h) * 0.92);
        } else if (uSeaY > -1e5) {
          float t = (uSeaY - uCam.y) / min(h, -0.0004);
          vec2 sp = (uCam.xz + d.xz * t) * 0.0045 + uWind * uTime * 0.004;
          float n = fbm(sp * 1.2);
          float cov = smoothstep(0.32, 0.62, n);
          float n2 = fbm(sp * 1.2 + uSunDir.xz * 0.02);
          vec3 sc = mix(uCloudDark, uCloudLight, clamp(0.55 + (n - n2) * 6.0, 0.0, 1.0));
          vec3 gap = mix(uZenith, uHorizon, 0.35) * 0.9;
          vec3 sea = mix(gap, sc, cov);
          col = mix(sea, uHorizon, smoothstep(250.0, 2400.0, t));
        } else {
          col = uHorizon;
        }
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
}

// ---------------------------------------------------------------------------
// Door portal surface and light beam.
// ---------------------------------------------------------------------------
export function makePortalMaterial({ horizon, zenith, glow }) {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    fog: false,
    uniforms: {
      uTime: { value: 0 },
      uHorizon: { value: new THREE.Color(horizon) },
      uZenith: { value: new THREE.Color(zenith) },
      uGlow: { value: new THREE.Color(glow) },
      uOpen: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime, uOpen;
      uniform vec3 uHorizon, uZenith, uGlow;
      varying vec2 vUv;
      ${NOISE_GLSL}
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float n = fbm(vec2(p.x * 1.8, p.y * 2.6 - uTime * 0.35) + 3.0);
        float n2 = fbm(vec2(p.x * 3.0 + uTime * 0.2, p.y * 4.0) - 7.0);
        vec3 sky = mix(uHorizon, uZenith, smoothstep(-0.9, 1.0, p.y + (n - 0.5) * 0.6));
        float edge = pow(max(abs(p.x), abs(p.y * 0.55)), 3.0);
        vec3 col = mix(sky, vec3(1.0), 0.28 + 0.25 * n2);
        col = mix(col, uGlow * 1.6, edge * 0.55);
        col *= 1.15 + 0.2 * sin(uTime * 1.3 + p.y * 2.0);
        // brighten when closed so light leaks around the leaf
        col *= mix(1.0, 1.35, 1.0 - uOpen);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
}

export function makeBeamMaterial(color) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uHeight: { value: 90 },
      uBase: { value: 0 },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec3 vNormalW;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uHeight, uBase, uTime;
      varying vec3 vWorld;
      varying vec3 vNormalW;
      void main() {
        vec3 v = normalize(cameraPosition - vWorld);
        float f = pow(abs(dot(normalize(vNormalW), v)), 1.6);
        float hh = clamp((vWorld.y - uBase) / uHeight, 0.0, 1.0);
        float a = f * pow(1.0 - hh, 1.5) * smoothstep(0.0, 0.02, hh);
        float d = distance(vWorld.xz, cameraPosition.xz);
        float horiz = length(vWorld.xz - cameraPosition.xz);
        a *= smoothstep(2.5, 16.0, horiz);
        a *= 0.85 + 0.15 * sin(uTime * 1.7 + hh * 30.0);
        gl_FragColor = vec4(uColor * a * 0.9, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
}

// ---------------------------------------------------------------------------
// Drifting particles (fireflies, sand, pollen). Positions are computed in the
// vertex shader and wrapped around the camera, so there is zero CPU cost.
// ---------------------------------------------------------------------------
export function makeParticles({ count, box = 60, color, size = 2.2, drift = [1, 0, 0], speed = 3, bob = 0.5, additive = true, opacity = 1, wind }) {
  const g = new THREE.BufferGeometry();
  const seeds = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    seeds[i * 4] = Math.random();
    seeds[i * 4 + 1] = Math.random();
    seeds[i * 4 + 2] = Math.random();
    seeds[i * 4 + 3] = Math.random();
  }
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    fog: false,
    uniforms: {
      uTime: wind ? wind.uTime : { value: 0 },
      uBox: { value: box },
      uColor: { value: new THREE.Color(color) },
      uSize: { value: size },
      uDrift: { value: new THREE.Vector3(...drift).multiplyScalar(speed) },
      uBob: { value: bob },
      uOpacity: { value: opacity },
      uScale: { value: 600 },
    },
    vertexShader: /* glsl */ `
      attribute vec4 aSeed;
      uniform float uTime, uBox, uSize, uBob, uScale;
      uniform vec3 uDrift;
      varying float vA;
      void main() {
        vec3 base = aSeed.xyz * uBox;
        vec3 p = base + uDrift * uTime * (0.6 + aSeed.w * 0.8);
        p.x += sin(uTime * 0.7 + aSeed.w * 30.0) * uBob;
        p.y += sin(uTime * 0.9 + aSeed.x * 40.0) * uBob;
        p.z += cos(uTime * 0.6 + aSeed.y * 25.0) * uBob;
        vec3 rel = mod(p - cameraPosition + uBox * 0.5, uBox) - uBox * 0.5;
        vec3 world = cameraPosition + rel;
        vec4 mv = viewMatrix * vec4(world, 1.0);
        gl_Position = projectionMatrix * mv;
        float dist = length(rel);
        vA = (1.0 - smoothstep(uBox * 0.3, uBox * 0.5, dist)) * (0.55 + 0.45 * sin(uTime * (1.2 + aSeed.w * 2.0) + aSeed.x * 50.0));
        gl_PointSize = uSize * uScale / max(-mv.z, 0.5) * (0.6 + aSeed.w * 0.8);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying float vA;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float a = smoothstep(1.0, 0.0, d);
        a *= a;
        gl_FragColor = vec4(uColor, a * vA * uOpacity);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  return pts;
}
