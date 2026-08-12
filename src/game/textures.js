import * as THREE from 'three';
import { makeRng } from './maze.js';
import wallpaperImage from '../media/textures/wallpaper.png';
import carpetImage from '../media/textures/carpet.png';

/**
 * Procedural surface textures, generated once into 256px canvases at boot.
 *
 * Production note: for shipped assets this pipeline should be swapped for KTX2
 * / Basis Universal (`KTX2Loader` + `setTranscoderPath`) so VRAM holds a
 * compressed block format instead of 4 bytes/texel of RGBA. See `makeTexture`
 * for the single choke point where that swap happens.
 *
 * Everything here is module-cached: the maze is one draw call per surface type,
 * so there is exactly one instance of each texture alive at a time.
 *
 * IMPORTANT: textures are baked into DataTexture (CPU ArrayBuffer), not left as
 * live CanvasTexture sources. After a long background pause browsers can wipe
 * canvas backing stores and/or recreate the WebGL context; on restore Three
 * re-uploads from the source image. A blank canvas makes every LevelShell map
 * (walls/floor/ceiling/concrete) vanish while untextured props still draw.
 */

const SIZE = 256;
let _cache = null;

function canvas2dSized(w, h) {
  const el = document.createElement('canvas');
  el.width = w;
  el.height = h;
  // willReadFrequently: we always snapshot the finished atlas into a DataTexture.
  return el.getContext('2d', { willReadFrequently: true });
}

function canvas2d() {
  return canvas2dSized(SIZE, SIZE);
}

function configureTexture(tex, repeat, aniso) {
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = aniso;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Snapshot a finished canvas into a DataTexture whose pixels live in a JS
 * ArrayBuffer that the browser cannot silently discard.
 */
function textureFromCanvas(canvas, repeat, aniso) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) || canvas.getContext('2d');
  const { width, height } = canvas;
  const imageData = ctx.getImageData(0, 0, width, height);
  // Own the buffer so later canvas reuse cannot alias the GPU upload source.
  const data = new Uint8Array(imageData.data);
  const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  return configureTexture(tex, repeat, aniso);
}

function makeTexture(ctx, repeat, aniso) {
  return textureFromCanvas(ctx.canvas, repeat, aniso);
}

/** Fine per-pixel grain, written straight into the ImageData byte buffer. */
function grain(ctx, amount, rng, w = SIZE, h = SIZE, ox = 0, oy = 0) {
  const img = ctx.getImageData(ox, oy, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = (rng() - 0.5) * amount;
    d[i] += v;
    d[i + 1] += v;
    d[i + 2] += v * 0.85;
  }
  ctx.putImageData(img, ox, oy);
}

function stains(ctx, rng, count, color, maxR, w = SIZE, h = SIZE, ox = 0, oy = 0) {
  for (let i = 0; i < count; i++) {
    const x = ox + rng() * w;
    const y = oy + rng() * h;
    const r = 6 + rng() * maxR;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

let _wallpaperTextureCache = null;
let _carpetTextureCache = null;

// Mildew / damp discoloration recipes. Kept faint so the grime reads as
// weathering, not a stamp. Scattered across an atlasN x atlasN tile grid so
// the splotch pattern repeats at a longer period than the base wallpaper,
// hiding the tiling.
const WALL_GRIME = [
  { count: 1, color: 'rgba(74, 82, 58, 0.18)', maxR: 42 }, // greenish mildew
  { count: 1, color: 'rgba(92, 86, 64, 0.16)', maxR: 30 },  // brownish damp
  { count: 1, color: 'rgba(38, 36, 26, 0.20)', maxR: 55 },  // dark water mark
];
const FLOOR_GRIME = [
  { count: 1, color: 'rgba(50, 46, 28, 0.22)', maxR: 60 },  // dark damp stain
  { count: 0, color: 'rgba(68, 74, 52, 0.16)', maxR: 38 },  // greenish mildew
];

/**
 * Loads a tileable source image, tiles it atlasN x atlasN into one canvas,
 * bakes faint mildew splotches + grain over the whole canvas, and returns a
 * durable DataTexture. repeat is set to 1/atlasN so the base pattern keeps its
 * original world-space density while the grime only cycles every atlasN tiles —
 * the two periods misalign, which breaks up the stamp look.
 *
 * One texture, one draw call, zero per-frame cost: all work is at load time.
 */
function buildCompositedTexture(imageUrl, aniso, atlasN, grimeRecipes, grimeSeed, grainAmount) {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE * atlasN;
  canvas.height = SIZE * atlasN;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  // Bind materials immediately to a durable (initially empty) DataTexture.
  // The image load path overwrites the pixel buffer — never leaves a live
  // canvas as the upload source.
  const placeholder = new Uint8Array(canvas.width * canvas.height * 4);
  const tex = new THREE.DataTexture(placeholder, canvas.width, canvas.height, THREE.RGBAFormat);
  configureTexture(tex, 1 / atlasN, aniso);

  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    const tw = img.naturalWidth || SIZE;
    const th = img.naturalHeight || SIZE;
    if (canvas.width !== tw * atlasN || canvas.height !== th * atlasN) {
      canvas.width = tw * atlasN;
      canvas.height = th * atlasN;
    }
    for (let y = 0; y < atlasN; y++) {
      for (let x = 0; x < atlasN; x++) {
        ctx.drawImage(img, x * tw, y * th, tw, th);
      }
    }
    const rng = makeRng(grimeSeed);
    const w = canvas.width;
    const h = canvas.height;
    for (const recipe of grimeRecipes) {
      stains(ctx, rng, recipe.count, recipe.color, recipe.maxR, w, h);
    }
    grain(ctx, grainAmount, rng, w, h);

    const imageData = ctx.getImageData(0, 0, w, h);
    const pixels = new Uint8Array(imageData.data);
    tex.image = { data: pixels, width: w, height: h };
    tex.needsUpdate = true;
  };
  img.src = imageUrl;

  return tex;
}

function buildWallpaper(aniso) {
  if (_wallpaperTextureCache) return _wallpaperTextureCache;
  _wallpaperTextureCache = buildCompositedTexture(
    wallpaperImage, aniso, 4, WALL_GRIME, 0x8a17, 12,
  );
  return _wallpaperTextureCache;
}

function buildCarpetImage(aniso) {
  if (_carpetTextureCache) return _carpetTextureCache;
  _carpetTextureCache = buildCompositedTexture(
    carpetImage, aniso, 4, FLOOR_GRIME, 0x3c41, 16,
  );
  return _carpetTextureCache;
}

/**
 * Ceiling tiles are baked as an atlas of CEIL_ATLAS_N x CEIL_ATLAS_N unique
 * panels rather than one panel repeated everywhere — a single repeating tile
 * reads as an obvious stamp the moment two stains line up under the lamps.
 * texture.repeat is set to 1/CEIL_ATLAS_N so each physical TEX_SCALE-sized
 * panel on the ceiling samples exactly one atlas cell before the whole grid
 * cycles and repeats (see getTextures).
 */
const CEIL_ATLAS_N = 10; // 100 panels: lets 5% / 1% map onto exact tile counts
const CEIL_ATLAS_SIZE = SIZE * CEIL_ATLAS_N;

const CEIL_STAIN_RECIPES = [
  { count: [5, 9], color: 'rgba(120,100,50,0.28)', maxR: 50 }, // water ring, wide + faint
  { count: [3, 6], color: 'rgba(58,68,42,0.34)', maxR: 26 }, // mold spotting, tight + dark
  { count: [2, 4], color: 'rgba(112,58,28,0.30)', maxR: 22 }, // rust bleed, small + sharp
  { count: [1, 2], color: 'rgba(38,34,24,0.32)', maxR: 74 }, // deep grime, one soft blotch
];

function randInt(rng, lo, hi) {
  return lo + ((rng() * (hi - lo + 1)) | 0);
}

function paintCeilingTileBase(ctx, ox, oy, rng) {
  ctx.fillStyle = '#d8d2bd';
  ctx.fillRect(ox, oy, SIZE, SIZE);

  // Acoustic tile pinholes.
  for (let i = 0; i < 2600; i++) {
    const x = ox + rng() * SIZE;
    const y = oy + rng() * SIZE;
    ctx.fillStyle = 'rgba(150,145,128,0.5)';
    ctx.fillRect(x, y, 1.4, 1.4);
  }
  // Tile grid (one border per panel).
  ctx.strokeStyle = 'rgba(110,105,92,0.75)';
  ctx.lineWidth = 3;
  ctx.strokeRect(ox, oy, SIZE, SIZE);
}

function paintCeilingStain(ctx, ox, oy, rng) {
  const recipe = CEIL_STAIN_RECIPES[(rng() * CEIL_STAIN_RECIPES.length) | 0];
  stains(ctx, rng, randInt(rng, recipe.count[0], recipe.count[1]), recipe.color, recipe.maxR, SIZE, SIZE, ox, oy);

  // A minority of stained panels are doubly grubby — a second, different recipe layered in.
  if (rng() < 0.25) {
    const second = CEIL_STAIN_RECIPES[(rng() * CEIL_STAIN_RECIPES.length) | 0];
    stains(ctx, rng, randInt(rng, second.count[0], second.count[1]), second.color, second.maxR, SIZE, SIZE, ox, oy);
  }
}

/** The one-in-a-hundred panel: either an open gap where a tile is missing, or one sagging half out of its frame. */
function paintCeilingAnomaly(ctx, ox, oy, rng) {
  if (rng() < 0.5) {
    // Missing tile: dark cavity above the grid.
    const g = ctx.createLinearGradient(ox, oy, ox, oy + SIZE);
    g.addColorStop(0, 'rgba(9,8,6,1)');
    g.addColorStop(1, 'rgba(2,2,2,1)');
    ctx.fillStyle = g;
    ctx.fillRect(ox, oy, SIZE, SIZE);

    // The frame still holds around the opening.
    ctx.strokeStyle = 'rgba(90,85,72,0.4)';
    ctx.lineWidth = 3;
    ctx.strokeRect(ox, oy, SIZE, SIZE);

    // Sparse debris catching what little light reaches into the gap.
    for (let i = 0; i < 40; i++) {
      const x = ox + rng() * SIZE;
      const y = oy + rng() * SIZE;
      ctx.fillStyle = `rgba(120,112,92,${(0.15 + rng() * 0.2).toFixed(2)})`;
      ctx.fillRect(x, y, 1.2, 1.2);
    }
  } else {
    // Dislodged tile: still in place but sagging, with a shadowed gap along its frame.
    paintCeilingTileBase(ctx, ox, oy, rng);
    paintCeilingStain(ctx, ox, oy, rng);

    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy, SIZE, SIZE);
    ctx.clip();

    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(ox, oy, SIZE, SIZE);

    const gap = 10 + rng() * 8;
    const edgeA = ctx.createLinearGradient(ox, oy, ox, oy + gap);
    edgeA.addColorStop(0, 'rgba(0,0,0,0.85)');
    edgeA.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = edgeA;
    ctx.fillRect(ox, oy, SIZE, gap);

    const edgeB = ctx.createLinearGradient(ox, oy, ox + gap, oy);
    edgeB.addColorStop(0, 'rgba(0,0,0,0.7)');
    edgeB.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = edgeB;
    ctx.fillRect(ox, oy, gap, SIZE);

    ctx.restore();
  }
}

function shuffledIndices(count, rng) {
  const arr = Array.from({ length: count }, (_, i) => i);
  for (let i = count - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
  return arr;
}

function buildCeilingAtlas(rng) {
  const ctx = canvas2dSized(CEIL_ATLAS_SIZE, CEIL_ATLAS_SIZE);
  const totalTiles = CEIL_ATLAS_N * CEIL_ATLAS_N;

  const order = shuffledIndices(totalTiles, rng);
  const anomalyIndex = order[0];
  const stainCount = Math.round(totalTiles * 0.05);
  const stainedIndices = new Set(order.slice(1, 1 + stainCount));

  for (let ty = 0; ty < CEIL_ATLAS_N; ty++) {
    for (let tx = 0; tx < CEIL_ATLAS_N; tx++) {
      const tileIndex = ty * CEIL_ATLAS_N + tx;
      const ox = tx * SIZE;
      const oy = ty * SIZE;

      if (tileIndex === anomalyIndex) {
        paintCeilingAnomaly(ctx, ox, oy, rng);
        continue;
      }

      paintCeilingTileBase(ctx, ox, oy, rng);
      if (stainedIndices.has(tileIndex)) {
        paintCeilingStain(ctx, ox, oy, rng);
      }
    }
  }

  grain(ctx, 14, rng, CEIL_ATLAS_SIZE, CEIL_ATLAS_SIZE);
  return ctx;
}

/**
 * Poured concrete: stair treads, ramps and the whole maintenance stratum.
 *
 * Kept coarse and cold on purpose. It is the one surface in the level that is
 * not office finish, so it has to carry the read that the player has left the
 * floor the building meant them to be on.
 */
function buildConcrete(rng) {
  const ctx = canvas2d();
  ctx.fillStyle = '#6c6a61';
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Exposed aggregate.
  for (let i = 0; i < 4200; i++) {
    const x = rng() * SIZE;
    const y = rng() * SIZE;
    const v = 84 + ((rng() * 74) | 0);
    ctx.fillStyle = `rgba(${v},${v - 3},${v - 11},${(0.14 + rng() * 0.34).toFixed(2)})`;
    ctx.fillRect(x, y, 1 + rng() * 1.7, 1 + rng() * 1.7);
  }

  // Damp bloom and the pale bloom of efflorescence.
  stains(ctx, rng, 5, 'rgba(38,38,36,0.22)', 44);
  stains(ctx, rng, 3, 'rgba(150,148,136,0.16)', 28);
  grain(ctx, 18, rng);
  return ctx;
}

/**
 * @param {number} maxAnisotropy from `gl.capabilities.getMaxAnisotropy()`
 */
export function getTextures(maxAnisotropy) {
  if (_cache) return _cache;
  const rng = makeRng(0x5eed1);
  const aniso = Math.min(4, maxAnisotropy || 1);
  _cache = {
    wall: buildWallpaper(aniso),
    carpet: buildCarpetImage(aniso),
    ceiling: makeTexture(buildCeilingAtlas(rng), 1 / CEIL_ATLAS_N, aniso),
    hard: makeTexture(buildConcrete(rng), 1, aniso),
  };
  return _cache;
}

/**
 * Force GPU re-upload of every cached surface. Call after a tab resume or
 * WebGL context restore so LevelShell maps reappear if the context was rebuilt.
 */
export function refreshTextures() {
  if (!_cache) return;
  for (const key in _cache) {
    const tex = _cache[key];
    if (tex) tex.needsUpdate = true;
  }
}

/** Explicit VRAM release. Call when the game surface is torn down for good. */
export function disposeTextures() {
  if (!_cache) return;
  for (const key in _cache) _cache[key].dispose();
  _cache = null;
  _wallpaperTextureCache = null;
  _carpetTextureCache = null;
}
