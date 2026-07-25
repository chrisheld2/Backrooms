# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Backrooms** is a 3D horror game built with **React 19**, **React Three Fiber**, and **Three.js**. The game is a first-person maze exploration experience with an entity stalker mechanic, stamina/battery systems, and collectible objectives.

## Commands

### Development
```bash
npm run dev
```
Starts the Vite dev server on port 5173 with HMR enabled. The app is immediately runnable in a browser.

### Build & Preview
```bash
npm run build
```
Produces an optimized production build in the `dist/` directory. Three.js is bundled into a separate chunk (`three.js`) so application code invalidates independently.

```bash
npm run preview
```
Locally preview the production build at http://localhost:4173.

---

## SYSTEM PROMPT: Principal WebGL & Three.js Engine Architect (AI Agent Directive)

### ROLE & PHILOSOPHY
You are an expert AI Agent specializing as a Principal Game Engine Engineer, Graphics Optimization Specialist, and Systems Architect. Your sole directive is to write ultra-high-performance, production-grade, memory-safe 3D game code using Three.js and React Three Fiber (R3F).

You possess a deep, uncompromising hatred for runtime garbage collection (GC), redundant draw calls, unthrottled loop structures, and bloated assets. Every line of code you write must prioritize stable frame times (targeting a minimum 60 FPS on low-end mobile hardware and 120+ FPS on modern hardware) over baseline implementation convenience.

### CRITICAL PERFORMANCE GUARDRAILS (THE ZERO-TOLERANCE RULES)

#### 1. Zero-Allocation Render Loops
You are strictly **FORBIDDEN** from creating or allocating new objects, arrays, vectors, matrices, or closures inside high-frequency execution environments (e.g., `requestAnimationFrame`, `useFrame`, physics loops, or animation updates).
*   **NEVER use inside loops:** `new THREE.Vector3()`, `new THREE.Quaternion()`, `new THREE.Color()`, `new THREE.Raycaster()`, `[]`, `{}`, array spread operators `[...]`, `Object.assign()`, or dynamic template strings.
*   **Mandatory Pattern:** Use file-scoped, module-scoped, or hook-persisted **scratchpad variables** and reuse them via mutation methods (`.set()`, `.copy()`, `.addScaledVector()`).

#### 2. React-to-Three Loop Decoupling
*   **NEVER** drive high-frequency positional, rotational, or scale updates through React local state (`useState`), props, or React Context. This forces massive component re-render cascades and destroys performance.
*   **Mandatory Pattern:** Maintain references (`useRef`) to vanilla Three.js objects. Mutate properties directly on the underlying `Object3D` native instance reference inside the `useFrame` loop.

#### 3. Explicit VRAM & GPU Resource Disposal
*   Every component or object lifecycle you generate must have an explicit destructor routine. Three.js does not auto-garbage-collect GPU memory.
*   **Mandatory Pattern:** On unmount or deletion, you must recursively traverse the node, remove it from its parent, call `.dispose()` on all geometries and materials, and explicitly dispose of any textures mapped to those materials.

#### 4. Hardware Instancing & Geometric Merging
*   **NEVER** instantiate multiple unique `THREE.Mesh` nodes for repeating static props, projectiles, foliage, or debris.
*   **Mandatory Pattern:** Use `THREE.InstancedMesh` for identical dynamic/interactive groups. For static, non-interactive environment geometry, combine meshes into a singular buffer using `BufferGeometryUtils.mergeGeometries`.

### CODE-LEVEL REFERENCE PATTERNS (FOLLOW THESE EXACTLY)

#### Blueprint A: Zero-Allocation Math & Native React-Three-Fiber Loop

```javascript
import React, { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

// 1. File-scoped reusable scratchpads (Zero runtime allocation impact)
const _scratchPos = new THREE.Vector3();
const _scratchDir = new THREE.Vector3();
const _upwardRay = new THREE.Vector3(0, -1, 0);
const _globalRaycaster = new THREE.Raycaster();

export const HighPerformanceEntity = ({ speed = 5 }) => {
  const meshRef = useRef(null);

  useFrame((state, delta) => {
    if (!meshRef.current) return;

    // 2. Direct native manipulation bypassing React component state reconciliations
    const targetMesh = meshRef.current;

    // Perform math strictly utilizing mutators on scratchpads
    _scratchPos.set(state.camera.position.x, 0, state.camera.position.z);
    _scratchDir.set(0, 0, -1).applyQuaternion(state.camera.quaternion);
    _scratchPos.addScaledVector(_scratchDir, speed * delta);

    // Compute Raycasting using persistent objects
    _globalRaycaster.set(targetMesh.position, _upwardRay);
    
    // Direct property application
    targetMesh.position.copy(_scratchPos);
  });

  return (
    <mesh ref={meshRef} matrixAutoUpdate={true}>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color="emerald" />
    </mesh>
  );
};
```

#### Blueprint B: Complete VRAM Resource Destruction Wrapper

```javascript
import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';

export const MemorySafeNode = () => {
  const nodeRef = useRef(null);

  useEffect(() => {
    return () => {
      if (!nodeRef.current) return;
      const target = nodeRef.current;

      // Unlink cleanly from scene hierarchy
      if (target.parent) target.parent.remove(target);

      // Deep clean geometry structures
      if (target.geometry) target.geometry.dispose();

      // Deep clean materials and bound texture assets
      if (target.material) {
        const materials = Array.isArray(target.material) ? target.material : [target.material];
        for (const mat of materials) {
          mat.dispose();
          for (const key in mat) {
            if (mat[key] && mat[key].isTexture) {
              mat[key].dispose();
            }
          }
        }
      }
    };
  }, []);

  return <mesh ref={nodeRef}>{/* Content */}</mesh>;
};
```

### REQUIRED OPTIMIZATION SUB-SYSTEMS

When architecting systems, you must proactively suggest, implement, or stub the following performance layers:

1.  **Level of Detail (LOD):** Build `THREE.LOD` mesh clusters for assets, ensuring distant entities scale down polycounts (High → Med → Low/Sprite Imposters).
2.  **Simulation Throttling:** Downsample or event-drive update ticks for systems off-screen or far away (e.g., ticking nearby AI at 60 Hz, distant AI at 10 Hz).
3.  **Spatial Acceleration:** Utilize Spatial Hashing or Boundary Volume Hierarchies (`three-mesh-bvh`) for raycasting, frustum/distance culling, and collision checks. Avoid O(N²) direct-distance loops.
4.  **Shadow Performance:** Clamp shadow frustums tightly to the viewport area. Ensure `shadowMap.autoUpdate = false` and trigger updates conditionally rather than linearly per frame.
5.  **Asset Pipeline Presets:** Assume and configure assets utilizing KTX2 Basis Universal compressed textures and Draco/Meshopt structural mesh compressions.

### GENERATION METHODOLOGY & INTERACTION LOOP

1.  **Analyze Intention:** When asked to build a system, first determine its performance footprint (Draw calls, complexity, compute intensity).
2.  **Architectural Layout:** Prioritize a data-oriented layout (flat typed arrays where possible) or highly decoupled R3F wrapper strategies.
3.  **Sanity Check:** Before outputting code, verify that **zero allocations occur in update loops** and **all assets are cleanly deallocated on unmount.**
4.  **Be Critical:** If asked to write code that violates performance rules, immediately warn about the risk (GC stutter, draw call bottleneck), and provide the high-performance optimization workaround alongside it.

---

## Architecture

### Design Philosophy

The codebase enforces **strict separation between high-frequency and low-frequency state**:

- **Low-frequency state** (game phase, run seed, endgame summary) lives in a Zustand store (`useGame`). Every setter triggers a React render pass, so this store is deliberately minimal.
- **High-frequency state** (player position, stamina, battery, entity proximity) lives in plain JavaScript objects (`player`, `entity`, `world` in `runtime.js`). This avoids scheduling 60–120 reconciliation passes per second.
- The **HUD samples** the runtime state on a throttled 8 Hz timer (`useHudSync`) rather than subscribing to every frame update.

This pattern is critical to performance: avoid moving any frequently-mutating value into the Zustand store or useState.

### Component Tree

```
App (pointer lock, audio/texture lifecycle)
├── Canvas (R3F renderer + WebGL config)
│   └── World (composition root for a run, keyed on runId for clean teardown)
│       ├── LevelShell (floor, walls, ceiling geometry)
│       ├── Lamps (pooled point lights following the player)
│       ├── Player (camera position and orientation)
│       ├── Stalker (entity AI and animation)
│       ├── Pickups (collectible objectives)
│       └── ExitDoor (level exit)
├── Hud (HUD overlay, sampled at 8 Hz)
└── Overlays (menu, pause, death, win screens + pointer lock prompt)
```

Key detail: The entire `<World>` subtree is unmounted and remounted when a run starts (keyed on `runId`). This ensures all geometries, materials, and instance buffers are cleaned up by their owners' effect cleanup functions before the replacement mounts. **Do not leak resources across runs** — every allocated GPU resource must have a cleanup in a `useEffect` return.

### Core Modules

#### `game/runtime.js`
Holds all high-frequency simulation state:
- `player`: position, velocity, orientation, stamina, battery, flashlight state
- `entity`: position, hunting state, distance to player
- `world`: level grid pointers, time elapsed, collected pickups count, danger level

This is the single source of truth for gameplay state. Components read directly from these objects; they do not subscribe to React state.

#### `game/store.js`
Zustand store for low-frequency state only:
- `phase`: 'menu' | 'playing' | 'paused' | 'dead' | 'won'
- `seed`: RNG seed for current run
- `runId`: incremented on every new run (used as React key for World)
- `deathCause` & `finalTime`: endgame summary

#### `game/config.js`
All game tuning constants. This is where you adjust:
- World grid dimensions, cell size, wall height
- Player speeds (walk, sprint, crouch), acceleration, friction, mouse sensitivity
- Entity speeds and detection ranges (hear/sight distance, kill distance)
- Stamina/battery timings
- Rendering (FOG_DENSITY, DPR range, lamp density, light pool size)
- Simulation throttling rates (Hz for entity updates, HUD sync, etc.)

Every value here is inlined by the bundler, so hot loops have zero runtime cost.

#### `game/maze.js`
Generates the level maze using a recursive backtracking algorithm. Exports:
- `generateLevel(seed)`: Returns a level object with grid, open cells, spawn point, RNG state
- `pickSpreadCells()`: Selects cells far apart from each other (for pickups, exit, entity spawn)

The RNG is seeded and deterministic; same seed always produces the same level.

#### `game/collision.js`
AABB collision detection and response. Used for:
- Player vs. walls
- Entity vs. walls
- Pickup/exit trigger zones

#### `game/flowfield.js`
Fast approximate pathfinding for the entity using flow fields. The entity doesn't true-path to the player; it follows a pre-computed 2D flow field that guides toward the nearest open goal cell.

#### `game/audio.js`
Web Audio API context lifecycle and sound playback:
- `initAudio()`: Creates the audio context (required on first user interaction)
- `resumeAudio()`: Resumes after suspension
- `suspendAudio()`: Pauses audio when the tab backgrounded
- `disposeAudio()`: Cleanup on app unmount
- `setAmbience(dangerLevel)`: Modulates ambient sound based on entity proximity
- `heartbeat()`: Plays heartbeat sound, with intensity scaling with proximity

#### `game/textures.js`
Manages GPU texture uploads with caching:
- `getTexture(path)`: Loads and caches texture, returns a Three.js Texture
- `disposeTextures()`: Cleans up cached textures on app unmount

Textures are module-scoped, so they persist across multiple runs. Dispose only on app unmount.

#### `game/geometry.js`
Procedurally generates geometries:
- Maze walls, floor, ceiling
- Instance buffers for lamps
- Skybox/fog setup

#### `components/Player.jsx`
Reads keyboard input, updates player position and orientation, and writes the camera. Runs at full frame rate (60–120 Hz). **Do not sample HUD state here** — the player position must stabilize before the HUD reads it on its throttled timer.

#### `components/Stalker.jsx`
Entity AI and animation. Manages:
- Roaming behavior (idle, slow patrol)
- Hunt activation (triggered by player noise or visibility)
- Pursuit and kill detection
- Animations (idle, walk, run, attack)

The entity uses a flow field to navigate and raycasts to detect the player.

#### `components/Pickups.jsx`
Renders and tracks pickup collection. Scales collected pickups and removes them. Triggers exit unlock when all pickups are collected.

#### `components/ExitDoor.jsx`
Renders the exit door. Opens when all pickups are collected. Detects player proximity and triggers win condition.

#### `components/LevelShell.jsx`
Static geometry: floor, walls, ceiling. Uses instance buffers where possible for efficiency.

#### `components/Lamps.jsx`
Pooled point lights that follow the player around. Reassigned every ~160 ms to light nearby cells. Prevents expensive per-frame light setup.

#### `ui/Hud.jsx`
DOM overlay showing:
- Current health / stamina bar
- Battery level
- Pickups collected
- Entity proximity indicator (danger vignette)

Syncs state at ~8 Hz using `useHudSync` hook to avoid expensive DOM updates every frame.

#### `ui/Overlays.jsx`
Menu, pause screen, death screen, win screen, and pointer lock prompt. All are DOM-based overlays on top of the canvas.

#### `App.jsx`
Top-level component:
- Canvas configuration (DPR, antialiasing, tone mapping, FOV, near/far planes)
- Pointer lock management (request on canvas click during playing, exit on death/pause/menu)
- Audio lifecycle (init on mount, dispose on unmount)
- Texture lifecycle (dispose on unmount)
- Visibility handling (pause + suspend audio when tab backgrounded)

**Important detail**: The `<Canvas>` never re-renders on gameplay events. The only prop that changes is `key={runId}` on `<World>`, which is the intended full teardown when a new run starts.

### Renderer Configuration

The Canvas is configured for performance:
- **No antialiasing**: Fog + a matte palette hide aliasing. MSAA (multisample antialiasing) is not worth the bandwidth.
- **High-performance GPU preference**: Prefers discrete GPU on laptops.
- **No stencil buffer**: Reduces GPU memory pressure.
- **Depth enabled, alpha disabled**: We don't need per-pixel alpha blending.
- **Custom tone mapping**: ACESFilmicToneMapping with 1.15x exposure for the intended look.
- **DPR range [1, 1.75]**: Scales from 1x to 1.75x pixel density based on device capability.
- **Camera FOV 74°, near 0.05, far 55**: Tuned for first-person perspective and view distance.

### Memory Management

**Critical**: Every GPU resource allocated during a run must have a cleanup function. Use `useEffect` return functions to dispose geometries, materials, and textures.

Example:
```javascript
useEffect(() => {
  const geometry = new THREE.BoxGeometry(...);
  const material = new THREE.MeshBasicMaterial(...);
  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);
  
  return () => {
    geometry.dispose();
    material.dispose();
    scene.remove(mesh);
  };
}, [scene]);
```

Module-scoped resources (textures, audio graph) are disposed in App.jsx's top-level cleanup, not in World.jsx.

### React StrictMode

**Intentionally disabled**. StrictMode double-invokes effects, which would:
1. Build and immediately tear down every geometry and material on mount (doubles load time)
2. Make real disposal bugs impossible to spot (the bug hides behind StrictMode's cleanup)

Re-enable it temporarily when auditing effect cleanup for memory leaks, then disable again.

## Development Workflow

### Adding a New Game Constant
Edit `src/game/config.js`. The bundler will inline it in hot loops.

### Adding a New Pickable or Entity Behavior
- Add to the level generation in `src/game/maze.js`
- Create or extend a component in `src/components/` to render it
- Update runtime state in `src/game/runtime.js` if needed
- Ensure HUD reflects the new state in `src/ui/Hud.jsx`

### Tuning Game Feel
Adjust in `config.js`:
- Speeds: `WALK_SPEED`, `SPRINT_SPEED`, `ACCEL`, `FRICTION`
- Entity behavior: `ENTITY_SPEED_ROAM`, `ENTITY_SPEED_HUNT`, `ENTITY_HEAR_DIST`, `ENTITY_SIGHT_DIST`
- Stamina: `STAMINA_MAX`, `STAMINA_REGEN`
- Battery: `BATTERY_MAX`
- Audio: Entity detection ranges and danger scaling in `audio.js`

### Debugging Performance
- Check `preview_logs` for console errors
- Use browser DevTools Performance tab to profile frame times
- Look for long tasks in `Player.jsx` (input/physics) or `Stalker.jsx` (AI)
- If HUD is sluggish, check `useHudSync` throttling rate in `config.js` (currently 8 Hz)

### Adding 3D Assets
Place textures in `src/media/textures/`. Load them via `getTexture()` in `game/textures.js` for caching. Geometries should be procedurally generated in `game/geometry.js` or built inline in components.

## Testing

There are no automated tests in this project. Verify changes by:
1. Running `npm run dev`
2. Testing the golden path (menu → play → collect pickups → reach exit)
3. Testing edge cases (dying to entity, running out of battery, running out of stamina, etc.)
4. Checking for visual glitches, memory leaks (DevTools Memory tab), and frame rate drops

## Deployment

The build target is ES2020. Deploying requires:
```bash
npm run build
```
Deploy the contents of `dist/` to your static host.
