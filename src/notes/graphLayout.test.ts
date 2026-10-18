import { describe, it, expect } from 'vitest';
import {
  buildGraphData,
  buildLocalGraph,
  initializePositions,
  simulateTick,
  parseQuery,
  noteMatchesQuery,
  TAG_NODE_PREFIX,
  DEFAULT_CONFIG,
  type GraphData,
} from './graphLayout';
import type { NoteIndexEntry } from './noteState';

function makeNote(partial: Partial<NoteIndexEntry> & { path: string }): NoteIndexEntry {
  const name = partial.name ?? partial.path.replace(/^.*\//, '').replace(/\.md$/, '');
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

describe('parseQuery', () => {
  it('should_parse_plain_text_as_any_field', () => {
    expect(parseQuery('hello')).toEqual([{ field: 'any', value: 'hello', negate: false }]);
  });

  it('should_parse_tag_path_file_operators', () => {
    expect(parseQuery('tag:project path:docs file:readme')).toEqual([
      { field: 'tag', value: 'project', negate: false },
      { field: 'path', value: 'docs', negate: false },
      { field: 'file', value: 'readme', negate: false },
    ]);
  });

  it('should_parse_negation_prefix', () => {
    expect(parseQuery('-tag:done')).toEqual([{ field: 'tag', value: 'done', negate: true }]);
  });

  it('should_strip_hash_prefix_and_lowercase', () => {
    expect(parseQuery('tag:#Work')).toEqual([{ field: 'tag', value: 'work', negate: false }]);
  });

  it('should_ignore_empty_tokens', () => {
    expect(parseQuery('  tag:  - ')).toEqual([]);
    expect(parseQuery('')).toEqual([]);
  });
});

describe('noteMatchesQuery', () => {
  const note = {
    path: '/notes/projects/alpha.md',
    name: 'alpha',
    title: 'Alpha Plan',
    tags: ['project', 'active'],
  };

  it('should_match_all_tokens_with_and_semantics', () => {
    expect(noteMatchesQuery(note, parseQuery('tag:project path:notes'))).toBe(true);
    expect(noteMatchesQuery(note, parseQuery('tag:project path:missing'))).toBe(false);
  });

  it('should_match_any_field_against_title_and_name', () => {
    expect(noteMatchesQuery(note, parseQuery('plan'))).toBe(true);
    expect(noteMatchesQuery(note, parseQuery('alpha'))).toBe(true);
    expect(noteMatchesQuery(note, parseQuery('beta'))).toBe(false);
  });

  it('should_exclude_on_negated_token', () => {
    expect(noteMatchesQuery(note, parseQuery('-tag:active'))).toBe(false);
    expect(noteMatchesQuery(note, parseQuery('-tag:done'))).toBe(true);
  });
});

describe('buildGraphData', () => {
  const notes: NoteIndexEntry[] = [
    makeNote({ path: '/n/a.md', name: 'a', title: 'Note A', tags: ['x'], outgoingLinks: ['b'] }),
    makeNote({ path: '/n/b.md', name: 'b', title: 'Note B', tags: ['x', 'y'] }),
    makeNote({ path: '/n/c.md', name: 'c', title: 'Note C', tags: ['z'] }),
  ];
  const backlinks = { '/n/b.md': ['/n/a.md'] };

  it('should_resolve_wikilinks_between_notes', () => {
    const data = buildGraphData(notes, backlinks);
    expect(data.nodes).toHaveLength(3);
    expect(data.edges).toHaveLength(1);
    expect(data.edges[0]).toMatchObject({ source: '/n/a.md', target: '/n/b.md', type: 'wikilink' });
  });

  it('should_drop_orphans_when_showOrphans_false', () => {
    const data = buildGraphData(notes, backlinks, { showOrphans: false });
    expect(data.nodes.map(n => n.id).sort()).toEqual(['/n/a.md', '/n/b.md']);
    expect(data.nodeMap.has('/n/c.md')).toBe(false);
  });

  it('should_filter_by_query_operators', () => {
    const data = buildGraphData(notes, backlinks, { filterQuery: 'tag:z' });
    expect(data.nodes.map(n => n.id)).toEqual(['/n/c.md']);
  });

  it('should_add_tag_nodes_with_tagnode_edges', () => {
    const data = buildGraphData(notes, backlinks, { showTagNodes: true });
    const tagNode = data.nodeMap.get(`${TAG_NODE_PREFIX}x`);
    expect(tagNode).toBeDefined();
    expect(tagNode!.kind).toBe('tag');
    expect(tagNode!.label).toBe('#x');
    const tagEdges = data.edges.filter(e => e.type === 'tagnode' && e.target === `${TAG_NODE_PREFIX}x`);
    expect(tagEdges.map(e => e.source).sort()).toEqual(['/n/a.md', '/n/b.md']);
  });

  it('should_mark_note_nodes_with_note_kind', () => {
    const data = buildGraphData(notes, backlinks);
    expect(data.nodes.every(n => n.kind === 'note')).toBe(true);
  });
});

describe('buildLocalGraph', () => {
  // chain: a — b — c — d
  const chain: GraphData = (() => {
    const notes = [
      makeNote({ path: 'a', name: 'a', outgoingLinks: ['b'] }),
      makeNote({ path: 'b', name: 'b', outgoingLinks: ['c'] }),
      makeNote({ path: 'c', name: 'c', outgoingLinks: ['d'] }),
      makeNote({ path: 'd', name: 'd' }),
    ];
    return buildGraphData(notes, {});
  })();

  it('should_keep_only_neighbors_at_depth_1', () => {
    const local = buildLocalGraph(chain, 'b', 1);
    expect(local.nodes.map(n => n.id).sort()).toEqual(['a', 'b', 'c']);
    expect(local.edges).toHaveLength(2);
  });

  it('should_expand_two_hops_at_depth_2', () => {
    const local = buildLocalGraph(chain, 'a', 2);
    expect(local.nodes.map(n => n.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('should_return_input_when_center_missing', () => {
    expect(buildLocalGraph(chain, 'nope', 1)).toBe(chain);
  });

  it('should_share_node_objects_with_input', () => {
    const local = buildLocalGraph(chain, 'b', 1);
    expect(local.nodeMap.get('b')).toBe(chain.nodeMap.get('b'));
  });
});

describe('simulateTick', () => {
  function makeGraph(count: number, linked: boolean): GraphData {
    const notes = Array.from({ length: count }, (_, i) =>
      makeNote({
        path: `n${i}`,
        name: `n${i}`,
        outgoingLinks: linked && i > 0 ? [`n${i - 1}`] : [],
      }));
    const data = buildGraphData(notes, {});
    initializePositions(data.nodes, 400, 300, 200, 'force');
    return data;
  }

  it('should_return_zero_energy_for_empty_graph', () => {
    const data = buildGraphData([], {});
    expect(simulateTick(data, DEFAULT_CONFIG, 400, 300)).toBe(0);
  });

  it('should_move_nodes_and_report_positive_energy', () => {
    const data = makeGraph(10, true);
    const before = data.nodes.map(n => ({ x: n.x, y: n.y }));
    const energy = simulateTick(data, DEFAULT_CONFIG, 400, 300);
    expect(energy).toBeGreaterThan(0);
    const moved = data.nodes.some((n, i) => n.x !== before[i].x || n.y !== before[i].y);
    expect(moved).toBe(true);
  });

  it('should_not_move_pinned_nodes', () => {
    const data = makeGraph(5, true);
    data.nodes[0].pinned = true;
    const { x, y } = data.nodes[0];
    simulateTick(data, DEFAULT_CONFIG, 400, 300);
    expect(data.nodes[0].x).toBe(x);
    expect(data.nodes[0].y).toBe(y);
  });

  it('should_stay_finite_on_large_graphs_via_barnes_hut', () => {
    const data = makeGraph(300, true);
    for (let tick = 0; tick < 30; tick++) {
      simulateTick(data, DEFAULT_CONFIG, 400, 300);
    }
    for (const node of data.nodes) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
    }
  });

  it('should_respect_linkDistance_config', () => {
    // Two linked nodes settle near the configured link distance
    const notes = [
      makeNote({ path: 'a', name: 'a', outgoingLinks: ['b'] }),
      makeNote({ path: 'b', name: 'b' }),
    ];
    const data = buildGraphData(notes, {});
    initializePositions(data.nodes, 400, 300, 100, 'force');
    const config = { ...DEFAULT_CONFIG, linkDistance: 60, gravity: 0 };
    for (let tick = 0; tick < 400; tick++) {
      simulateTick(data, config, 400, 300);
    }
    const [a, b] = data.nodes;
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    // Repulsion pushes slightly beyond the ideal length; assert sane band
    expect(dist).toBeGreaterThan(40);
    expect(dist).toBeLessThan(200);
  });
});
