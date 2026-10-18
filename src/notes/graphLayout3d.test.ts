import { describe, it, expect } from 'vitest';
import { initializePositions3D, simulateTick3D, projectNode } from './graphLayout3d';
import { buildGraphData, DEFAULT_CONFIG, type GraphData } from './graphLayout';
import type { NoteIndexEntry } from './noteState';

function makeNote(partial: Partial<NoteIndexEntry> & { path: string }): NoteIndexEntry {
  const name = partial.name ?? partial.path;
  return {
    name,
    title: name,
    frontmatter: null,
    tags: [],
    outgoingLinks: [],
    incomingLinks: [],
    modifiedAt: '2026-01-01T00:00:00Z',
    size: 100,
    excerpt: '',
    ...partial,
  };
}

function makeGraph(count: number): GraphData {
  const notes = Array.from({ length: count }, (_, i) =>
    makeNote({
      path: `n${i}`,
      name: `n${i}`,
      outgoingLinks: i > 0 ? [`n${i - 1}`] : [],
    }));
  return buildGraphData(notes, {});
}

describe('initializePositions3D', () => {
  it('should_place_single_node_at_origin', () => {
    const data = makeGraph(1);
    initializePositions3D(data.nodes, 200);
    expect(data.nodes[0]).toMatchObject({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 });
  });

  it('should_place_nodes_on_sphere_of_given_radius', () => {
    const data = makeGraph(50);
    initializePositions3D(data.nodes, 200);
    for (const node of data.nodes) {
      const r = Math.sqrt(node.x * node.x + node.y * node.y + node.z * node.z);
      expect(r).toBeGreaterThan(190);
      expect(r).toBeLessThan(210);
    }
  });

  it('should_zero_velocities', () => {
    const data = makeGraph(5);
    data.nodes.forEach(n => { n.vx = 9; n.vy = 9; n.vz = 9; });
    initializePositions3D(data.nodes, 100);
    expect(data.nodes.every(n => n.vx === 0 && n.vy === 0 && n.vz === 0)).toBe(true);
  });
});

describe('simulateTick3D', () => {
  it('should_return_zero_energy_for_empty_graph', () => {
    const data = buildGraphData([], {});
    expect(simulateTick3D(data, DEFAULT_CONFIG)).toBe(0);
  });

  it('should_move_nodes_and_report_positive_energy', () => {
    const data = makeGraph(10);
    initializePositions3D(data.nodes, 150);
    const before = data.nodes.map(n => ({ x: n.x, y: n.y, z: n.z }));
    const energy = simulateTick3D(data, DEFAULT_CONFIG);
    expect(energy).toBeGreaterThan(0);
    const moved = data.nodes.some((n, i) =>
      n.x !== before[i].x || n.y !== before[i].y || n.z !== before[i].z);
    expect(moved).toBe(true);
  });

  it('should_not_move_pinned_nodes', () => {
    const data = makeGraph(5);
    initializePositions3D(data.nodes, 150);
    data.nodes[0].pinned = true;
    const { x, y, z } = data.nodes[0];
    simulateTick3D(data, DEFAULT_CONFIG);
    expect(data.nodes[0].x).toBe(x);
    expect(data.nodes[0].y).toBe(y);
    expect(data.nodes[0].z).toBe(z);
  });

  it('should_stay_finite_over_many_ticks', () => {
    const data = makeGraph(120);
    initializePositions3D(data.nodes, 200);
    for (let tick = 0; tick < 60; tick++) {
      simulateTick3D(data, DEFAULT_CONFIG);
    }
    for (const node of data.nodes) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
      expect(Number.isFinite(node.z)).toBe(true);
    }
  });
});

describe('projectNode', () => {
  it('should_project_origin_to_canvas_center', () => {
    const p = projectNode(0, 0, 0, 0.4, 1.2, 600, 620, 400, 300);
    expect(p.sx).toBeCloseTo(400);
    expect(p.sy).toBeCloseTo(300);
    expect(p.viewZ).toBeCloseTo(600);
    expect(p.scale).toBeCloseTo(620 / 600);
  });

  it('should_scale_up_points_closer_to_the_camera', () => {
    // No rotation: -z moves toward the camera
    const nearPoint = projectNode(100, 0, -200, 0, 0, 600, 620, 400, 300);
    const farPoint = projectNode(100, 0, 200, 0, 0, 600, 620, 400, 300);
    expect(nearPoint.scale).toBeGreaterThan(farPoint.scale);
    expect(nearPoint.viewZ).toBeLessThan(farPoint.viewZ);
  });

  it('should_keep_screen_x_for_y_axis_rotation_of_y_points', () => {
    // Points on the Y axis are invariant under Y rotation
    const a = projectNode(0, 150, 0, 0, 0, 600, 620, 400, 300);
    const b = projectNode(0, 150, 0, 0, 2.1, 600, 620, 400, 300);
    expect(a.sx).toBeCloseTo(b.sx);
    expect(a.sy).toBeCloseTo(b.sy);
  });

  it('should_clamp_viewZ_to_avoid_negative_scale_blowup', () => {
    const p = projectNode(0, 0, -900, 0, 0, 600, 620, 400, 300);
    expect(p.scale).toBeLessThanOrEqual(620 / 40);
    expect(Number.isFinite(p.sx)).toBe(true);
  });
});
