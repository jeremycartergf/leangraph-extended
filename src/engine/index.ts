/**
 * Hybrid Execution Engine
 *
 * This module provides a hybrid query execution approach that combines
 * SQL for efficient indexed lookups with in-memory graph traversal for
 * complex pattern matching.
 *
 * @example
 * ```typescript
 * import { HybridExecutor } from './engine';
 *
 * const executor = new HybridExecutor(db);
 * const results = executor.executeVarLengthPattern({
 *   anchorLabel: 'Person',
 *   anchorProps: { name: 'Alice' },
 *   varEdgeType: 'KNOWS',
 *   varMinDepth: 1,
 *   varMaxDepth: 3,
 *   varDirection: 'out',
 *   middleLabel: 'Person',
 *   middleFilter: (node) => node.properties.age > 25,
 *   finalEdgeType: 'WORKS_AT',
 *   finalDirection: 'out',
 *   finalLabel: 'Company',
 * });
 * ```
 */

// Core types
export type {
  Direction,
  Path,
  MemoryNode,
  MemoryEdge,
  NodeRow,
  EdgeRow,
} from './memory-graph';
export type { SubgraphBounds, PropertyFilter } from './subgraph-loader';
export type { VarLengthPatternParams, PatternResult } from './hybrid-executor';
export type { HybridAnalysisResult } from './query-planner';

// Classes
export { MemoryGraph } from './memory-graph';
export { SubgraphLoader } from './subgraph-loader';
export { HybridExecutor } from './hybrid-executor';

// Query Planner functions
export {
  analyzeForHybrid,
  isHybridCompatiblePattern,
  extractNodeInfo,
  convertWhereToFilter,
} from './query-planner';
