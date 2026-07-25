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
  },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float time, vignette, grain, scanlines, chromaticAberration, pixelation, blur, saturation, contrast, grayscale, sepia, invert;
    uniform vec2 resolution; varying vec2 vUv;
    float rand(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 uv = vUv;
      if (pixelation > 0.0) { float size = mix(1.0, 12.0, pixelation); uv = (floor(uv * resolution / size) * size + size * .5) / resolution; }
      vec2 b = vec2(blur / resolution.x, blur / resolution.y);
      vec2 c = vec2(chromaticAberration / resolution.x, chromaticAberration / resolution.y);
      vec3 color = vec3(texture2D(tDiffuse, uv - c).r, texture2D(tDiffuse, uv).g, texture2D(tDiffuse, uv + c).b);
      if (blur > 0.0) color = (color + texture2D(tDiffuse, uv + b).rgb + texture2D(tDiffuse, uv - b).rgb + texture2D(tDiffuse, uv + vec2(b.x, -b.y)).rgb + texture2D(tDiffuse, uv + vec2(-b.x, b.y)).rgb) / 5.0;
      float luma = dot(color, vec3(.299, .587, .114));
      color = mix(color, vec3(luma), grayscale);
      color = mix(color, vec3(dot(color, vec3(.393,.769,.189)), dot(color, vec3(.349,.686,.168)), dot(color, vec3(.272,.534,.131))), sepia);
      color = mix(color, vec3(1.0) - color, invert);
      color = mix(vec3(luma), color, 1.0 + saturation);
      color = (color - .5) * (1.0 + contrast) + .5;
      float edge = distance(uv, vec2(.5)) * 1.414;
      color *= 1.0 - vignette * smoothstep(.35, 1.0, edge);
      color += (rand(uv + fract(time)) - .5) * grain;
      color *= 1.0 - scanlines * (.5 + .5 * sin(uv.y * resolution.y * 1.5));
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
