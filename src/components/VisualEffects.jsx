import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const shader = {
  uniforms: {
    tDiffuse: { value: null }, time: { value: 0 }, resolution: { value: new THREE.Vector2(1, 1) },
    vignette: { value: 0 }, grain: { value: 0 }, scanlines: { value: 0 }, chromaticAberration: { value: 0 },
    pixelation: { value: 0 }, blur: { value: 0 }, saturation: { value: 0 }, contrast: { value: 0 },
    grayscale: { value: 0 }, sepia: { value: 0 }, invert: { value: 0 },
    analogVCR: { value: 0 }, vcrJitter: { value: 0 }, vcrTear: { value: 0 },
  },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float time, vignette, grain, scanlines, chromaticAberration, pixelation, blur, saturation, contrast, grayscale, sepia, invert, analogVCR, vcrJitter, vcrTear;
    uniform vec2 resolution; varying vec2 vUv;
    float rand(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    float noise(vec2 p) { return rand(floor(p)); }
    void main() {
      vec2 uv = vUv;
      if (pixelation > 0.0) { float size = mix(1.0, 12.0, pixelation); uv = (floor(uv * resolution / size) * size + size * .5) / resolution; }

      // --- Analog VCR: horizontal jitter + tearing + chromatic split ----------
      float vcrJit = 0.0;
      float vcrTearOff = 0.0;
      float vcrBand = 0.0;
      if (analogVCR > 0.0) {
        float line = floor(uv.y * resolution.y);
        // Per-line horizontal jitter: a stable-per-line random offset, refreshed
        // a few times per second so the striping shimmers rather than freezing.
        float jitSeed = floor(time * 18.0);
        vcrJit = (rand(vec2(line, jitSeed)) - .5) * 0.04 * vcrJitter * analogVCR;
        // Tearing: a horizontal band whose vertical position drifts over time.
        // Higher vcrTear = more frequent tear events per second.
        float tearRate = max(0.1, vcrTear * 6.0);
        float tearPhase = fract(time * tearRate);
        float tearY = fract(sin(floor(time * tearRate) * 12.9898) * 0.5);
        float bandHalf = 0.02 + 0.03 * rand(vec2(floor(time * tearRate)));
        float dist = abs(uv.y - tearY);
        vcrBand = smoothstep(bandHalf, 0.0, dist);
        vcrTearOff = vcrBand * (rand(vec2(line, floor(time * tearRate))) - .5) * 0.12 * analogVCR;
      }
      vec2 vcrOffset = vec2(vcrJit + vcrTearOff, 0.0);

      vec2 b = vec2(blur / resolution.x, blur / resolution.y);
      float ca = chromaticAberration + analogVCR * 0.0025;
      vec2 c = vec2(ca / resolution.x, ca / resolution.y);
      vec3 color = vec3(
        texture2D(tDiffuse, uv + vcrOffset - c).r,
        texture2D(tDiffuse, uv + vcrOffset).g,
        texture2D(tDiffuse, uv + vcrOffset + c).b
      );
      if (blur > 0.0) color = (color + texture2D(tDiffuse, uv + vcrOffset + b).rgb + texture2D(tDiffuse, uv + vcrOffset - b).rgb + texture2D(tDiffuse, uv + vcrOffset + vec2(b.x, -b.y)).rgb + texture2D(tDiffuse, uv + vcrOffset + vec2(-b.x, b.y)).rgb) / 5.0;
      float luma = dot(color, vec3(.299, .587, .114));
      color = mix(color, vec3(luma), grayscale);
      color = mix(color, vec3(dot(color, vec3(.393,.769,.189)), dot(color, vec3(.349,.686,.168)), dot(color, vec3(.272,.534,.131))), sepia);
      color = mix(color, vec3(1.0) - color, invert);
      color = mix(vec3(luma), color, 1.0 + saturation);
      color = (color - .5) * (1.0 + contrast) + .5;
      float edge = distance(uv, vec2(.5)) * 1.414;
      color *= 1.0 - vignette * smoothstep(.35, 1.0, edge);
      color += (rand(uv + fract(time)) - .5) * grain;
      float sl = scanlines + analogVCR * 0.35;
      color *= 1.0 - sl * (.5 + .5 * sin(uv.y * resolution.y * 1.5));
      if (analogVCR > 0.0) {
        // VHS color bleed: smear red a touch downward, lift blue slightly.
        color.r = mix(color.r, texture2D(tDiffuse, uv + vcrOffset + vec2(0.0, 1.5 / resolution.y)).r, 0.35 * analogVCR);
        color.b += 0.02 * analogVCR;
        // Tear band brightness flicker.
        color += vcrBand * 0.08 * analogVCR * (rand(vec2(floor(time * 30.0))) - .5);
        // Extra coarse grain inside the effect.
        color += (noise(uv * vec2(2.0, 1.0) + floor(time * 24.0)) - .5) * 0.12 * analogVCR;
        // Slight green/amber cast for that aged-tape look.
        color = mix(color, color * vec3(1.05, 1.02, 0.92), analogVCR);
      }
      gl_FragColor = vec4(color, 1.0);
    }`,
};

/** Composer-managed scene effects. Settings are updated live without recreating GPU resources. */
export default function VisualEffects({ settings }) {
  const { gl, scene, camera, size } = useThree();
  const { composer, bloom, pass } = useMemo(() => {
    const composer = new EffectComposer(gl);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(size.width, size.height), 0, 0.45, 0.2);
    composer.addPass(bloom);
    const pass = new ShaderPass(shader);
    composer.addPass(pass);
    composer.addPass(new OutputPass());
    return { composer, bloom, pass };
  }, [gl, scene, camera]);

  useEffect(() => {
    composer.setSize(size.width, size.height);
    pass.uniforms.resolution.value.set(size.width * gl.getPixelRatio(), size.height * gl.getPixelRatio());
  }, [composer, pass, gl, size]);
  useEffect(() => () => composer.dispose(), [composer]);

  useFrame((_, delta) => {
    bloom.strength = settings.bloom;
    bloom.enabled = settings.bloom > 0;
    Object.entries(settings).forEach(([key, value]) => {
      if (pass.uniforms[key]) pass.uniforms[key].value = value;
    });
    pass.uniforms.time.value += delta;
    composer.render(delta);
  }, 1);
  return null;
}
