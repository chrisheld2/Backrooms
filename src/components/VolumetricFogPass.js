import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const MAX_LIGHTS = 4;

const fogShader = {
  uniforms: {
    tDepth: { value: null },
    cameraNear: { value: 0.05 },
    cameraFar: { value: 55 },
    cameraProjectionMatrixInverse: { value: new THREE.Matrix4() },
    cameraMatrixWorld: { value: new THREE.Matrix4() },
    cameraPositionWorld: { value: new THREE.Vector3() },
    time: { value: 0 },
    stepCount: { value: 14 },
    density: { value: 0.018 },
    fogColor: { value: new THREE.Color(0x81744d) },
    lightCount: { value: 0 },
    lightPosition: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector3()) },
    lightColor: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Color()) },
    lightPower: { value: new Float32Array(MAX_LIGHTS) },
    lightRange: { value: new Float32Array(MAX_LIGHTS) },
    flashEnabled: { value: 0 },
    flashPosition: { value: new THREE.Vector3() },
    flashDirection: { value: new THREE.Vector3(0, 0, -1) },
    flashColor: { value: new THREE.Color(0xfff0cc) },
    flashPower: { value: 0 },
    flashCosAngle: { value: Math.cos(0.62) },
  },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: `
    #include <packing>
    varying vec2 vUv;
    uniform sampler2D tDepth;
    uniform float cameraNear, cameraFar, time, density;
    uniform int stepCount, lightCount;
    uniform mat4 cameraProjectionMatrixInverse, cameraMatrixWorld;
    uniform vec3 cameraPositionWorld, fogColor;
    uniform vec3 lightPosition[${MAX_LIGHTS}], lightColor[${MAX_LIGHTS}];
    uniform float lightPower[${MAX_LIGHTS}], lightRange[${MAX_LIGHTS}];
    uniform float flashEnabled, flashPower, flashCosAngle;
    uniform vec3 flashPosition, flashDirection, flashColor;

    float hash(vec3 p) {
      p = fract(p * 0.1031); p += dot(p, p.yzx + 33.33);
      return fract((p.x + p.y) * p.z);
    }

    void main() {
      float depth = texture2D(tDepth, vUv).x;
      vec4 viewFar = cameraProjectionMatrixInverse * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
      vec3 viewDir = normalize(viewFar.xyz / viewFar.w);
      vec3 rayDir = normalize((cameraMatrixWorld * vec4(viewDir, 0.0)).xyz);
      float viewZ = perspectiveDepthToViewZ(depth, cameraNear, cameraFar);
      float rayLength = depth >= 0.999999 ? cameraFar : min(cameraFar, -viewZ / max(0.001, -viewDir.z));
      float stepLength = rayLength / float(stepCount);
      float jitter = hash(vec3(gl_FragCoord.xy, floor(time * 24.0)));
      vec3 scattering = vec3(0.0);
      float transmittance = 1.0;

      for (int s = 0; s < 24; s++) {
        if (s >= stepCount) break;
        float along = (float(s) + jitter) * stepLength;
        vec3 p = cameraPositionWorld + rayDir * along;
        float drift = sin(p.x * 0.17 + time * 0.035) * sin(p.z * 0.14 - time * 0.028);
        float localDensity = density * (0.82 + 0.18 * drift);
        vec3 illumination = fogColor * 0.16;

        for (int i = 0; i < ${MAX_LIGHTS}; i++) {
          if (i >= lightCount) break;
          vec3 toLight = lightPosition[i] - p;
          float dist = length(toLight);
          float rangeFade = pow(clamp(1.0 - dist / lightRange[i], 0.0, 1.0), 2.0);
          illumination += lightColor[i] * lightPower[i] * rangeFade / (1.0 + dist * dist * 0.16);
        }

        if (flashEnabled > 0.5) {
          vec3 fromFlash = p - flashPosition;
          float dist = length(fromFlash);
          float cone = smoothstep(flashCosAngle, mix(flashCosAngle, 1.0, 0.42), dot(normalize(fromFlash), flashDirection));
          float rangeFade = pow(clamp(1.0 - dist / 24.0, 0.0, 1.0), 2.0);
          illumination += flashColor * flashPower * cone * rangeFade / (1.0 + dist * dist * 0.055);
        }

        float extinction = localDensity * stepLength;
        float sampleAlpha = 1.0 - exp(-extinction);
        scattering += transmittance * sampleAlpha * illumination;
        transmittance *= 1.0 - sampleAlpha;
        if (transmittance < 0.015) break;
      }
      gl_FragColor = vec4(scattering, transmittance);
    }`,
};

const compositeShader = {
  uniforms: { tDiffuse: { value: null }, tFog: { value: null } },
  vertexShader: fogShader.vertexShader,
  fragmentShader: `
    varying vec2 vUv; uniform sampler2D tDiffuse, tFog;
    void main() {
      vec4 fog = texture2D(tFog, vUv);
      gl_FragColor = vec4(texture2D(tDiffuse, vUv).rgb * fog.a + fog.rgb, 1.0);
    }`,
};

/** Half/quarter-resolution screen-space raymarched fog, composited before bloom. */
export default class VolumetricFogPass extends Pass {
  constructor(scene, camera) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.quality = 2;
    this.width = 1;
    this.height = 1;
    this.scale = 0.5;
    this.fogTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });
    this.fogMaterial = new THREE.ShaderMaterial({ ...fogShader, uniforms: THREE.UniformsUtils.clone(fogShader.uniforms), depthTest: false, depthWrite: false });
    this.compositeMaterial = new THREE.ShaderMaterial({ ...compositeShader, uniforms: THREE.UniformsUtils.clone(compositeShader.uniforms), depthTest: false, depthWrite: false });
    this.fogQuad = new FullScreenQuad(this.fogMaterial);
    this.compositeQuad = new FullScreenQuad(this.compositeMaterial);
    this._flashDir = new THREE.Vector3();
  }

  setQuality(value) {
    const quality = Math.max(0, Math.min(3, Math.round(value || 0)));
    if (quality === this.quality) return;
    this.quality = quality;
    this.enabled = quality > 0;
    const steps = [0, 8, 14, 22][quality];
    this.scale = quality === 1 ? 0.25 : 0.5;
    this.fogMaterial.uniforms.stepCount.value = steps;
    this.fogMaterial.uniforms.density.value = quality === 1 ? 0.014 : quality === 2 ? 0.018 : 0.022;
    this.fogTarget.setSize(Math.max(1, Math.round(this.width * this.scale)), Math.max(1, Math.round(this.height * this.scale)));
  }

  setSize(width, height) {
    this.width = width;
    this.height = height;
    this.fogTarget.setSize(Math.max(1, Math.round(width * this.scale)), Math.max(1, Math.round(height * this.scale)));
  }

  updateLights() {
    const u = this.fogMaterial.uniforms;
    let count = 0;
    let flash = null;
    this.scene.traverseVisible((node) => {
      if (node.isSpotLight) { if (node.intensity > 0) flash = node; return; }
      if (!node.isPointLight || node.intensity <= 0 || count >= MAX_LIGHTS) return;
      node.getWorldPosition(u.lightPosition.value[count]);
      u.lightColor.value[count].copy(node.color);
      u.lightPower.value[count] = Math.min(2.2, node.intensity * 0.07);
      u.lightRange.value[count] = node.distance || 18;
      count++;
    });
    u.lightCount.value = count;
    u.flashEnabled.value = flash ? 1 : 0;
    if (flash) {
      flash.getWorldPosition(u.flashPosition.value);
      flash.target.getWorldPosition(this._flashDir);
      u.flashDirection.value.copy(this._flashDir).sub(u.flashPosition.value).normalize();
      u.flashColor.value.copy(flash.color);
      u.flashPower.value = Math.min(3, flash.intensity * 0.075);
      u.flashCosAngle.value = Math.cos(flash.angle);
    }
  }

  render(renderer, writeBuffer, readBuffer, deltaTime) {
    const u = this.fogMaterial.uniforms;
    if (!readBuffer.depthTexture) return;
    u.tDepth.value = readBuffer.depthTexture;
    u.cameraNear.value = this.camera.near;
    u.cameraFar.value = this.camera.far;
    u.cameraProjectionMatrixInverse.value.copy(this.camera.projectionMatrixInverse);
    u.cameraMatrixWorld.value.copy(this.camera.matrixWorld);
    u.cameraPositionWorld.value.setFromMatrixPosition(this.camera.matrixWorld);
    u.time.value += deltaTime;
    this.updateLights();

    renderer.setRenderTarget(this.fogTarget);
    renderer.clear();
    this.fogQuad.render(renderer);
    this.compositeMaterial.uniforms.tDiffuse.value = readBuffer.texture;
    this.compositeMaterial.uniforms.tFog.value = this.fogTarget.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.compositeQuad.render(renderer);
  }

  dispose() {
    this.fogTarget.dispose();
    this.fogMaterial.dispose();
    this.compositeMaterial.dispose();
    this.fogQuad.dispose();
    this.compositeQuad.dispose();
  }
}
