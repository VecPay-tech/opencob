/**
 * Metrics module — Code complexity analysis and dependency graph modeling.
 */
export {
  computeCyclomaticComplexity,
  computeMaxNestingDepth,
  computeComplexityScore,
  classifyRisk,
  aggregateScores,
  type ComplexityScore,
  type ComplexityScan,
} from './complexity-scanner.js';

export {
  DependencyGraph,
  propagateVulnerabilities,
  degradeSeverity,
  DEP_WEIGHTS,
  type RefType,
  type DepEdge,
  type DepNode,
  type ReachableNode,
  type VulnerabilityImpact,
  type SecurityFinding,
} from './dependency-graph.js';

export {
  scanRepo,
  dependencyTree,
  impactAnalysis,
  buildOrder,
  generateBuildScript,
  repoSummary,
  unresolvedReferences,
  impactMarkdown,
  inferObjectType,
  type ObjectType,
  type CrossRefType,
  type SourceObject,
  type ImpactResult,
  type BuildOrderResult,
  type BuildScriptResult,
  type RepoSummary,
  type UnresolvedRef,
  type DependencyTreeNode,
} from './dependency-engine.js';

export {
  scanFileQuality,
  scanQuality,
  getAvailableCheckers,
  DEFAULT_RULES,
  type Severity,
  type QualityRule,
  type QualityIssue,
  type QualityScanResult,
} from './quality-rules.js';

export {
  loadRules,
  loadRulesSync,
  fetchEeRules,
  convertEeRules,
  getAvailablePresets,
  type RuleConfigFile,
  type RuleOverride,
  type EeRemoteRule,
  type RuleLoadResult,
} from './rule-loader.js';
