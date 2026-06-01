/**
 * Dependency Graph — Weighted graph model for legacy program dependencies.
 *
 * Ported from Codex security.py DEP_WEIGHTS + vulnerability propagation.
 * Models: CALL, COPY, CICS LINK, FILE I/O edges with coupling strength.
 * Provides: transitive traversal, vulnerability impact propagation.
 */

/** Reference / dependency type between files */
export type RefType = 'call' | 'cics_link' | 'copy' | 'include' | 'file_io' | 'perform' | 'sql';

/** Coupling strength per reference type (1.0 = strongest) */
export const DEP_WEIGHTS: Record<RefType, number> = {
  call: 1.0,
  cics_link: 1.0,
  copy: 0.8,
  include: 0.8,
  file_io: 0.6,
  perform: 0.0, // Internal only — no cross-file propagation
  sql: 0.5,
};

/** A directed edge in the dependency graph */
export interface DepEdge {
  source: string; // File/program ID
  target: string; // Referenced file/program ID
  refType: RefType;
  weight: number;
  line?: number;
}

/** Node in the dependency graph */
export interface DepNode {
  id: string;
  filePath?: string;
  label: string;
  extension?: string;
  platform?: string;
}

/** Result of a transitive traversal */
export interface ReachableNode {
  nodeId: string;
  hops: number;
  path: string[]; // Node IDs from source to this node
  accumulatedWeight: number; // Product of edge weights along path
}

/** Vulnerability impact record */
export interface VulnerabilityImpact {
  /** File where the original vulnerability exists */
  sourceFileId: string;
  /** File that is transitively affected */
  affectedFileId: string;
  /** Original severity (from finding) */
  originalSeverity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  /** Degraded severity based on hop distance */
  inheritedSeverity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  /** Number of hops from source to affected file */
  hopCount: number;
  /** Call path from source → affected */
  callPath: string[];
  /** Accumulated weight along path */
  couplingStrength: number;
}

/**
 * Weighted dependency graph with traversal and vulnerability propagation.
 */
export class DependencyGraph {
  private nodes = new Map<string, DepNode>();
  private outEdges = new Map<string, DepEdge[]>(); // forward: who does this file call?
  private inEdges = new Map<string, DepEdge[]>(); // reverse: who calls this file?

  /** Add a node to the graph */
  addNode(node: DepNode): void {
    this.nodes.set(node.id, node);
  }

  /** Add a weighted edge */
  addEdge(source: string, target: string, refType: RefType, line?: number): void {
    const weight = DEP_WEIGHTS[refType];
    const edge: DepEdge = { source, target, refType, weight, line };

    if (!this.outEdges.has(source)) this.outEdges.set(source, []);
    this.outEdges.get(source)!.push(edge);

    if (!this.inEdges.has(target)) this.inEdges.set(target, []);
    this.inEdges.get(target)!.push(edge);

    // Ensure both nodes exist
    if (!this.nodes.has(source)) this.nodes.set(source, { id: source, label: source });
    if (!this.nodes.has(target)) this.nodes.set(target, { id: target, label: target });
  }

  /** Get node by ID */
  getNode(id: string): DepNode | undefined {
    return this.nodes.get(id);
  }

  /** Get all nodes */
  getAllNodes(): DepNode[] {
    return [...this.nodes.values()];
  }

  /** Get outgoing edges from a node */
  getOutEdges(nodeId: string): DepEdge[] {
    return this.outEdges.get(nodeId) ?? [];
  }

  /** Get incoming edges to a node */
  getInEdges(nodeId: string): DepEdge[] {
    return this.inEdges.get(nodeId) ?? [];
  }

  /** Total node count */
  get nodeCount(): number {
    return this.nodes.size;
  }

  /** Total edge count */
  get edgeCount(): number {
    let count = 0;
    for (const edges of this.outEdges.values()) count += edges.length;
    return count;
  }

  /**
   * BFS transitive traversal from a start node.
   * @param startId Starting node
   * @param direction 'forward' (who does this call?) or 'reverse' (who calls this?)
   * @param maxDepth Maximum hop depth
   * @param minWeight Minimum accumulated weight to continue traversal
   */
  transitive(
    startId: string,
    direction: 'forward' | 'reverse' = 'forward',
    maxDepth: number = 5,
    minWeight: number = 0.1,
  ): ReachableNode[] {
    const results: ReachableNode[] = [];
    const visited = new Set<string>([startId]);
    const queue: Array<{ nodeId: string; hops: number; path: string[]; weight: number }> = [
      { nodeId: startId, hops: 0, path: [startId], weight: 1.0 },
    ];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.hops >= maxDepth) continue;

      const edges =
        direction === 'forward'
          ? this.getOutEdges(current.nodeId)
          : this.getInEdges(current.nodeId);

      for (const edge of edges) {
        const nextId = direction === 'forward' ? edge.target : edge.source;
        if (visited.has(nextId)) continue;
        // Skip internal-only references
        if (edge.weight === 0) continue;

        const accWeight = current.weight * edge.weight;
        if (accWeight < minWeight) continue;

        visited.add(nextId);
        const newPath = [...current.path, nextId];
        results.push({
          nodeId: nextId,
          hops: current.hops + 1,
          path: newPath,
          accumulatedWeight: accWeight,
        });
        queue.push({ nodeId: nextId, hops: current.hops + 1, path: newPath, weight: accWeight });
      }
    }

    return results;
  }

  /**
   * Find all strongly connected components (cycles) using Tarjan's algorithm.
   * Returns groups of node IDs that form cycles.
   */
  findCycles(): string[][] {
    const index = new Map<string, number>();
    const lowlink = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const sccs: string[][] = [];
    let idx = 0;

    const strongconnect = (v: string): void => {
      index.set(v, idx);
      lowlink.set(v, idx);
      idx++;
      stack.push(v);
      onStack.add(v);

      for (const edge of this.getOutEdges(v)) {
        const w = edge.target;
        if (!index.has(w)) {
          strongconnect(w);
          lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
        } else if (onStack.has(w)) {
          lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
        }
      }

      if (lowlink.get(v) === index.get(v)) {
        const scc: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          scc.push(w);
        } while (w !== v);
        if (scc.length > 1) {
          sccs.push(scc);
        }
      }
    };

    for (const nodeId of this.nodes.keys()) {
      if (!index.has(nodeId)) {
        strongconnect(nodeId);
      }
    }

    return sccs;
  }
}

// ── Vulnerability Propagation ────────────────────────────────

const SEVERITY_ORDER: Array<VulnerabilityImpact['originalSeverity']> = [
  'info',
  'low',
  'medium',
  'high',
  'critical',
];

/**
 * Degrade severity by hop distance.
 * Each hop reduces severity by one level.
 */
export function degradeSeverity(
  severity: VulnerabilityImpact['originalSeverity'],
  hops: number,
): VulnerabilityImpact['inheritedSeverity'] {
  const idx = SEVERITY_ORDER.indexOf(severity);
  const degraded = Math.max(0, idx - hops);
  return SEVERITY_ORDER[degraded];
}

/** Security finding input for propagation */
export interface SecurityFinding {
  fileId: string;
  severity: VulnerabilityImpact['originalSeverity'];
  message: string;
}

/**
 * Propagate vulnerabilities through the dependency graph.
 * For each finding, traverse reverse edges to find all callers that inherit risk.
 */
export function propagateVulnerabilities(
  findings: SecurityFinding[],
  graph: DependencyGraph,
  maxDepth: number = 5,
): VulnerabilityImpact[] {
  const impacts: VulnerabilityImpact[] = [];

  for (const finding of findings) {
    const reachable = graph.transitive(finding.fileId, 'reverse', maxDepth);

    for (const reached of reachable) {
      const inherited = degradeSeverity(finding.severity, reached.hops);
      // Only propagate if inherited severity is meaningful
      if (inherited === 'info' && finding.severity !== 'info') continue;

      impacts.push({
        sourceFileId: finding.fileId,
        affectedFileId: reached.nodeId,
        originalSeverity: finding.severity,
        inheritedSeverity: inherited,
        hopCount: reached.hops,
        callPath: reached.path,
        couplingStrength: reached.accumulatedWeight,
      });
    }
  }

  return impacts;
}
