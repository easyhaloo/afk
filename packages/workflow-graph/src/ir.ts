export const graphSchemaVersion = 1 as const;

export type GraphKind = 'workflow';
export type GraphStepKind = 'agent' | 'tool' | 'gate' | 'system';
export type GraphTrackKind = 'default' | 'conditional' | 'parallel';
export type GraphEdgeKind = 'dependency' | 'conditional';
export type DiagnosticSeverity = 'info' | 'warning' | 'error';
export type GraphDiagnosticCode =
  | 'duplicate-id'
  | 'missing-dependency'
  | 'missing-condition-step'
  | 'cycle'
  | 'geometry/no-route'
  | 'invalid-snapshot';

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export type RouteSegment =
  | { readonly kind: 'horizontal'; readonly from: Point; readonly to: Point }
  | { readonly kind: 'vertical'; readonly from: Point; readonly to: Point };

export interface OrthogonalRoute {
  readonly points: readonly Point[];
  readonly segments: readonly RouteSegment[];
}

export interface WorkflowCondition {
  readonly step: string;
  readonly equals: string;
}

export interface GraphStep {
  readonly id: string;
  readonly kind?: GraphStepKind;
  readonly role?: string;
  readonly provider?: string;
  readonly action?: string;
  readonly when?: WorkflowCondition;
  readonly dependsOn: readonly string[];
  readonly label?: string;
  readonly description?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly contentHash?: string;
}

export interface WorkflowGraphDefinition {
  readonly templateId: string;
  readonly templateVersion: number;
  readonly name: string;
  readonly description?: string;
  readonly steps: readonly GraphStep[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface GraphNode {
  readonly id: string;
  readonly stepId: string;
  readonly label: string;
  readonly kind: GraphStepKind;
  readonly role?: string;
  readonly provider?: string;
  readonly action?: string;
  readonly trackId: string;
  readonly bounds: Rect;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface GraphEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly kind: GraphEdgeKind;
  readonly label?: string;
  readonly route?: OrthogonalRoute;
}

export interface GraphTrack {
  readonly id: string;
  readonly label: string;
  readonly kind: GraphTrackKind;
  readonly bounds?: Rect;
}

export interface GraphDiagnostic {
  readonly severity: DiagnosticSeverity;
  readonly code: GraphDiagnosticCode;
  readonly message: string;
  readonly stepId?: string;
  readonly edgeId?: string;
}

export interface GraphSnapshot {
  readonly schemaVersion: typeof graphSchemaVersion;
  readonly kind: GraphKind;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly tracks: readonly GraphTrack[];
  readonly bounds: Rect;
  readonly diagnostics: readonly GraphDiagnostic[];
  readonly receipt?: GraphReceipt;
}

export interface GraphReceipt {
  readonly inputHash: string;
  readonly snapshotHash: string;
  readonly coreVersion: string;
  readonly generatedAt: string;
}

export interface WorkflowGraphPreferences {
  readonly nodeWidth?: number;
  readonly nodeHeight?: number;
  readonly columnGap?: number;
  readonly rowGap?: number;
  readonly trackGap?: number;
  readonly margin?: number;
}
