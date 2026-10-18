/**
 * graphLayout3d.ts
 *
 * 3D force layout + perspective projection for the Note Graph 3D view.
 * Pure TypeScript, no external dependencies — renders on the existing
 * Canvas 2D via projectNode().
 *
 * Forces mirror graphLayout.ts but act in 3D around the origin:
 *   - Pairwise charge repulsion
 *   - Spring attraction along edges (linkDistance)
 *   - Gravity toward the origin
 *   - Velocity damping
 */

import type { GraphData, GraphNode, SimulationConfig } from './graphLayout';

// ───────────────────────── Initialize Positions ─────────────────────────

/**
 * Place nodes on a Fibonacci sphere so the cloud starts evenly distributed.
 */
export function initializePositions3D(nodes: GraphNode[], radius: number): void {
  const n = nodes.length;
  if (n === 0) return;
  if (n === 1) {
    nodes[0].x = 0;
    nodes[0].y = 0;
    nodes[0].z = 0;
    nodes[0].vx = 0;
    nodes[0].vy = 0;
    nodes[0].vz = 0;
    return;
  }
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const y = 1 - 2 * t;
    const ringR = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    nodes[i].x = Math.cos(theta) * ringR * radius;
    nodes[i].y = y * radius;
    nodes[i].z = Math.sin(theta) * ringR * radius;
    nodes[i].vx = 0;
    nodes[i].vy = 0;
    nodes[i].vz = 0;
  }
}

// ───────────────────────── Simulation Tick ─────────────────────────

/**
 * Run one tick of 3D force simulation around the origin.
 * Returns total kinetic energy for convergence detection.
 */
export function simulateTick3D(data: GraphData, config: SimulationConfig): number {
  const { nodes, edges, nodeMap } = data;
  const n = nodes.length;
  if (n === 0) return 0;

  // In 3D the same charge spreads over a volume instead of a plane, so the
  // cloud collapses with 2D-tuned forces — boost repulsion, soften gravity.
  const repulsion = config.repulsion * 2.2;
  const gravity = config.gravity * 0.5;

  const fx = new Float64Array(n);
  const fy = new Float64Array(n);
  const fz = new Float64Array(n);

  // Pairwise charge repulsion (converges and stops, so O(n²) stays acceptable)
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = nodes[j].x - nodes[i].x;
      const dy = nodes[j].y - nodes[i].y;
      const dz = nodes[j].z - nodes[i].z;
      let distSq = dx * dx + dy * dy + dz * dz;
      if (distSq < 1) distSq = 1;
      const dist = Math.sqrt(distSq);
      const force = repulsion / distSq;
      const fdx = (dx / dist) * force;
      const fdy = (dy / dist) * force;
      const fdz = (dz / dist) * force;
      fx[i] -= fdx;
      fy[i] -= fdy;
      fz[i] -= fdz;
      fx[j] += fdx;
      fy[j] += fdy;
      fz[j] += fdz;
    }
  }

  // Edge spring attraction
  const indexOfNode = new Map<string, number>();
  for (let i = 0; i < n; i++) indexOfNode.set(nodes[i].id, i);

  for (const edge of edges) {
    const srcNode = nodeMap.get(edge.source);
    const tgtNode = nodeMap.get(edge.target);
    if (!srcNode || !tgtNode) continue;
    const si = indexOfNode.get(edge.source);
    const ti = indexOfNode.get(edge.target);
    if (si === undefined || ti === undefined) continue;

    const dx = tgtNode.x - srcNode.x;
    const dy = tgtNode.y - srcNode.y;
    const dz = tgtNode.z - srcNode.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const strength = edge.type === 'tag' ? config.attraction * 0.3 : config.attraction;
    const idealLen = edge.type === 'tag'
      ? config.linkDistance * 1.65
      : edge.type === 'tagnode'
        ? config.linkDistance * 0.75
        : config.linkDistance;
    const displacement = dist - idealLen;
    const fdx = (dx / dist) * displacement * strength;
    const fdy = (dy / dist) * displacement * strength;
    const fdz = (dz / dist) * displacement * strength;
    fx[si] += fdx;
    fy[si] += fdy;
    fz[si] += fdz;
    fx[ti] -= fdx;
    fy[ti] -= fdy;
    fz[ti] -= fdz;
  }

  // Gravity toward the origin
  for (let i = 0; i < n; i++) {
    fx[i] -= nodes[i].x * gravity;
    fy[i] -= nodes[i].y * gravity;
    fz[i] -= nodes[i].z * gravity;
  }

  // Apply forces with damping
  let kineticEnergy = 0;
  for (let i = 0; i < n; i++) {
    if (nodes[i].pinned) continue;

    nodes[i].vx = (nodes[i].vx + fx[i]) * config.damping;
    nodes[i].vy = (nodes[i].vy + fy[i]) * config.damping;
    nodes[i].vz = (nodes[i].vz + fz[i]) * config.damping;

    const speed = Math.sqrt(
      nodes[i].vx * nodes[i].vx + nodes[i].vy * nodes[i].vy + nodes[i].vz * nodes[i].vz,
    );
    if (speed > config.maxVelocity) {
      const clamp = config.maxVelocity / speed;
      nodes[i].vx *= clamp;
      nodes[i].vy *= clamp;
      nodes[i].vz *= clamp;
    }

    nodes[i].x += nodes[i].vx;
    nodes[i].y += nodes[i].vy;
    nodes[i].z += nodes[i].vz;

    kineticEnergy +=
      nodes[i].vx * nodes[i].vx + nodes[i].vy * nodes[i].vy + nodes[i].vz * nodes[i].vz;
  }

  return kineticEnergy;
}

// ───────────────────────── Projection ─────────────────────────

export interface Projected {
  sx: number;
  sy: number;
  /** Perspective scale factor (fov / viewZ) */
  scale: number;
  /** Distance from the camera plane — larger is farther */
  viewZ: number;
}

/**
 * Rotate a world point around Y then X, and project it with a perspective
 * camera sitting `dist` away from the origin looking at it.
 */
export function projectNode(
  x: number,
  y: number,
  z: number,
  rotX: number,
  rotY: number,
  dist: number,
  fov: number,
  cx: number,
  cy: number,
): Projected {
  const cosY = Math.cos(rotY);
  const sinY = Math.sin(rotY);
  const x1 = x * cosY + z * sinY;
  const z1 = -x * sinY + z * cosY;

  const cosX = Math.cos(rotX);
  const sinX = Math.sin(rotX);
  const y1 = y * cosX - z1 * sinX;
  const z2 = y * sinX + z1 * cosX;

  const viewZ = z2 + dist;
  const scale = fov / Math.max(viewZ, 40);
  return { sx: cx + x1 * scale, sy: cy + y1 * scale, scale, viewZ };
}
