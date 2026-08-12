import * as THREE from 'three';

/**
 * Geometry for everything that dresses the level: furniture, doors, handrails.
 *
 * Each builder returns ONE BufferGeometry assembled from boxes, so a prop type
 * is a single InstancedMesh however many parts it is made of — a desk is a top
 * and two panels, but it costs one draw call for every desk in the building.
 *
 * All part colours are baked into a vertex-colour attribute, which lets every
 * prop, every door and every handrail in the level share a single untextured
 * MeshLambertMaterial. No maps means no UVs are emitted at all.
 *
 * Built once per run and disposed by the component that owns them.
 */

// Corner sign triples per face, wound CCW as seen from that face's outward
// normal, followed by the outward normal itself.
const FACES = [
  { c: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]], n: [1, 0, 0] },
  { c: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]], n: [-1, 0, 0] },
  { c: [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]], n: [0, 1, 0] },
  { c: [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]], n: [0, -1, 0] },
  { c: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], n: [0, 0, 1] },
  { c: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]], n: [0, 0, -1] },
];

/**
 * Accumulates axis-aligned boxes (optionally yawed about a pivot, which is how
 * a door leaf hangs off its hinge) into one non-indexed buffer.
 */
function boxSink() {
  const pos = [];
  const nrm = [];
  const col = [];

  function push(x, y, z, nx, ny, nz, r, g, b) {
    pos.push(x, y, z);
    nrm.push(nx, ny, nz);
    col.push(r, g, b);
  }

  return {
    /**
     * @param {number} yaw   rotation about +Y, applied around (px, pz)
     */
    box(cx, cy, cz, hx, hy, hz, hex, yaw = 0, px = cx, pz = cz) {
      const r = ((hex >> 16) & 255) / 255;
      const g = ((hex >> 8) & 255) / 255;
      const b = (hex & 255) / 255;
      const s = Math.sin(yaw);
      const c = Math.cos(yaw);

      for (let f = 0; f < 6; f++) {
        const face = FACES[f];
        // Rotate the outward normal to match the box.
        const nx = face.n[0] * c + face.n[2] * s;
        const nz = -face.n[0] * s + face.n[2] * c;
        const ny = face.n[1];

        const vx = new Array(4);
        const vy = new Array(4);
        const vz = new Array(4);
        for (let i = 0; i < 4; i++) {
          const lx = cx + face.c[i][0] * hx;
          const ly = cy + face.c[i][1] * hy;
          const lz = cz + face.c[i][2] * hz;
          const dx = lx - px;
          const dz = lz - pz;
          vx[i] = px + dx * c + dz * s;
          vy[i] = ly;
          vz[i] = pz - dx * s + dz * c;
        }

        push(vx[0], vy[0], vz[0], nx, ny, nz, r, g, b);
        push(vx[1], vy[1], vz[1], nx, ny, nz, r, g, b);
        push(vx[2], vy[2], vz[2], nx, ny, nz, r, g, b);
        push(vx[0], vy[0], vz[0], nx, ny, nz, r, g, b);
        push(vx[2], vy[2], vz[2], nx, ny, nz, r, g, b);
        push(vx[3], vy[3], vz[3], nx, ny, nz, r, g, b);
      }
    },

    build() {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
      geo.computeBoundingSphere();
      return geo;
    },
  };
}

// ---------------------------------------------------------------------------
// Furniture. Origin at floor level, facing local +Z.
// ---------------------------------------------------------------------------

const PLASTIC = 0x5d636e;
const PLASTIC_DARK = 0x33373f;
const WOOD = 0x6d5735;
const WOOD_DARK = 0x4a3a22;
const METAL = 0x74695a;
const METAL_DARK = 0x453e34;
const RUST = 0x6b4a2e;

/**
 * A stacking chair on its side. Built lying down rather than upright-then-rolled
 * so the contact with the floor is exact and no instance carries a second
 * rotation.
 */
export function buildChairGeometry() {
  const s = boxSink();
  // Seat pan, now vertical: the chair has fallen onto its left side.
  s.box(0, 0.26, 0, 0.03, 0.23, 0.23, PLASTIC);
  // Backrest, hinged off the seat and lying at an angle to it.
  s.box(0, 0.30, -0.30, 0.03, 0.24, 0.03, PLASTIC);
  s.box(0.0, 0.46, -0.26, 0.02, 0.22, 0.20, PLASTIC);
  // Four legs, splayed out into the air.
  s.box(0.20, 0.06, 0.18, 0.19, 0.02, 0.02, PLASTIC_DARK);
  s.box(0.20, 0.06, -0.18, 0.19, 0.02, 0.02, PLASTIC_DARK);
  s.box(0.20, 0.46, 0.18, 0.19, 0.02, 0.02, PLASTIC_DARK);
  s.box(0.20, 0.46, -0.18, 0.19, 0.02, 0.02, PLASTIC_DARK);
  return s.build();
}

/** A wooden desk. Placed facing a wall, which is the whole joke. */
export function buildDeskGeometry() {
  const s = boxSink();
  s.box(0, 0.72, 0, 0.75, 0.035, 0.34, WOOD); // top
  s.box(-0.68, 0.36, 0, 0.03, 0.36, 0.30, WOOD_DARK); // side panel
  s.box(0.68, 0.36, 0, 0.03, 0.36, 0.30, WOOD_DARK);
  s.box(0, 0.52, -0.30, 0.66, 0.16, 0.02, WOOD_DARK); // modesty panel
  return s.build();
}

/** A four-drawer filing cabinet, rusted through at the base. */
export function buildCabinetGeometry() {
  const s = boxSink();
  s.box(0, 0.66, 0, 0.26, 0.66, 0.31, METAL);
  for (let i = 0; i < 4; i++) {
    const y = 0.20 + i * 0.31;
    s.box(0, y, 0.315, 0.23, 0.13, 0.012, METAL_DARK); // drawer front
    s.box(0, y, 0.33, 0.07, 0.02, 0.01, METAL); // pull
  }
  s.box(0, 0.04, 0, 0.265, 0.04, 0.315, RUST); // corroded plinth
  return s.build();
}

// ---------------------------------------------------------------------------
// Doors. Origin at the floor on the room side of the wall, opening toward +Z.
// ---------------------------------------------------------------------------

const DOOR_W = 0.46; // half width
const DOOR_H = 2.04;
const FRAME = 0x4c4030;
const LEAF = 0x7b6a4d;
const LEAF_DEAD = 0x6f6046;
const HANDLE = 0x9a8f6a;

function addFrame(s) {
  s.box(-DOOR_W - 0.06, DOOR_H * 0.5, 0, 0.06, DOOR_H * 0.5, 0.09, FRAME);
  s.box(DOOR_W + 0.06, DOOR_H * 0.5, 0, 0.06, DOOR_H * 0.5, 0.09, FRAME);
  s.box(0, DOOR_H + 0.06, 0, DOOR_W + 0.12, 0.06, 0.09, FRAME);
}

/** The 85%: a leaf flush in its frame that will never move. */
export function buildDoorLockedGeometry() {
  const s = boxSink();
  addFrame(s);
  s.box(0, DOOR_H * 0.5, 0, DOOR_W, DOOR_H * 0.5, 0.035, LEAF_DEAD);
  s.box(DOOR_W - 0.10, 1.02, 0.06, 0.045, 0.025, 0.028, HANDLE);
  return s.build();
}

/** The 15%: swung open on its hinge, onto whatever is actually back there. */
export function buildDoorOpenGeometry() {
  const s = boxSink();
  addFrame(s);
  // Hinged on the left jamb and pushed ~34° into the space beyond.
  s.box(0, DOOR_H * 0.5, -0.06, DOOR_W, DOOR_H * 0.5, 0.035, LEAF, -0.6, -DOOR_W, 0);
  return s.build();
}

// ---------------------------------------------------------------------------
// Supporting architecture for the tall spaces.
// ---------------------------------------------------------------------------

const CONCRETE = 0x6a6760;
const CONCRETE_DARK = 0x4c4a45;
const PIPE_A = 0x5f5a4e;
const PIPE_B = 0x6d5f45;
const CABLE = 0x272522;

/**
 * A load-bearing column, built ONE world unit tall with its base at y=0 and
 * instanced with a per-column Y scale. An atrium's ceiling is not flat, so
 * every column has to reach its own bit of soffit; baking the height in would
 * mean one geometry per column and one draw call each.
 *
 * Slightly tapered and capped, so a twelve-metre column still reads as
 * architecture at a glance rather than as an extruded box.
 */
export function buildPillarGeometry() {
  const s = boxSink();
  s.box(0, 0.5, 0, 0.42, 0.5, 0.42, CONCRETE); // shaft
  s.box(0, 0.02, 0, 0.52, 0.02, 0.52, CONCRETE_DARK); // plinth
  s.box(0, 0.985, 0, 0.50, 0.015, 0.50, CONCRETE_DARK); // capital
  // Formwork seams down two faces — vertical scale stretches these into the
  // long board-marks a poured column actually has.
  s.box(0.425, 0.5, 0, 0.01, 0.48, 0.10, CONCRETE_DARK);
  s.box(-0.425, 0.5, 0, 0.01, 0.48, 0.10, CONCRETE_DARK);
  return s.build();
}

/** A bundled pipe run, lying along local X, hung just under a low soffit. */
export function buildPipeGeometry() {
  const s = boxSink();
  s.box(0, 0, -0.16, 1.7, 0.085, 0.085, PIPE_A);
  s.box(0, -0.04, 0.02, 1.7, 0.06, 0.06, PIPE_B);
  s.box(0, 0.02, 0.16, 1.7, 0.045, 0.045, PIPE_A);
  // Hanger straps back up to the ceiling.
  for (const u of [-1.1, 0, 1.1]) {
    s.box(u, 0.12, -0.16, 0.02, 0.12, 0.02, CONCRETE_DARK);
    s.box(u, 0.12, 0.16, 0.02, 0.12, 0.02, CONCRETE_DARK);
  }
  return s.build();
}

/** A sagging bundle of cable, three segments approximating the catenary. */
export function buildConduitGeometry() {
  const s = boxSink();
  s.box(-1.15, 0.10, 0, 0.58, 0.035, 0.035, CABLE);
  s.box(0, -0.02, 0, 0.62, 0.04, 0.045, CABLE);
  s.box(1.15, 0.10, 0, 0.58, 0.035, 0.035, CABLE);
  return s.build();
}

/**
 * The framing left showing where a ceiling tile is gone: two joists and the
 * grid tee that used to carry the panel.
 */
export function buildJoistGeometry() {
  const s = boxSink();
  s.box(0, 0.30, -0.55, 1.55, 0.09, 0.03, CONCRETE_DARK);
  s.box(0, 0.30, 0.55, 1.55, 0.09, 0.03, CONCRETE_DARK);
  s.box(0, 0.02, 0, 1.58, 0.02, 0.02, 0x8a8578); // surviving grid tee
  s.box(0, 0.44, 0, 0.9, 0.05, 0.42, 0x3a3830); // duct running away into the dark
  return s.build();
}

// ---------------------------------------------------------------------------
// Handrails. A unit box, instanced with a non-uniform scale per rail and post.
// ---------------------------------------------------------------------------

export function buildRailGeometry() {
  const s = boxSink();
  s.box(0, 0, 0, 0.5, 0.5, 0.5, 0x7d5b3c);
  return s.build();
}

export function buildPropMaterial() {
  return new THREE.MeshLambertMaterial({ vertexColors: true, fog: true });
}
