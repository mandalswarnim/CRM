import type { CriteriaFilter } from '../automation/criteria.js';

export type FlowProcessType = 'AutoLaunchedFlow' | 'RecordTriggered' | 'Scheduled' | 'Screen';
export type FlowStatus = 'Draft' | 'Active' | 'Obsolete';

export interface FlowTrigger {
  objectApi?: string;
  on?: 'create' | 'update' | 'createOrUpdate' | 'delete';
  /** before-save flows mutate the record in flight; after-save flows may do DML. */
  when?: 'before' | 'after';
  conditions?: CriteriaFilter[];
  conditionFormula?: string;
  schedule?: { cron?: string; frequency?: string; startDate?: string };
}

export interface FlowVariable {
  name: string;
  dataType?: 'Text' | 'Number' | 'Currency' | 'Date' | 'DateTime' | 'Boolean' | 'Record' | 'RecordCollection';
  isCollection?: boolean;
  isInput?: boolean;
  isOutput?: boolean;
  value?: unknown;
}

/** An assignment step: `target` receives `value`, optionally combined with what is there. */
export interface AssignmentItem {
  target: string;
  operator?: 'assign' | 'add' | 'subtract' | 'addItem';
  value: unknown;
}

export interface DecisionOutcome {
  name: string;
  conditions?: CriteriaFilter[];
  /** Formula alternative to conditions; evaluated against the flow scope. */
  formula?: string;
  logic?: 'and' | 'or';
  next?: string;
}

export type FlowNode =
  | { type: 'assignment'; assignments: AssignmentItem[]; next?: string }
  | { type: 'decision'; outcomes: DecisionOutcome[]; defaultNext?: string }
  | { type: 'loop'; collection: string; loopVariable: string; firstNext?: string; afterLast?: string }
  | { type: 'getRecords'; object: string; filters?: CriteriaFilter[]; storeIn: string; first?: boolean; limit?: number; orderBy?: string; next?: string }
  | { type: 'createRecords'; object: string; fields?: Record<string, unknown>; from?: string; storeIdIn?: string; next?: string }
  | { type: 'updateRecords'; object: string; recordId?: string; from?: string; fields?: Record<string, unknown>; next?: string }
  | { type: 'deleteRecords'; object: string; recordId?: string; from?: string; next?: string }
  | { type: 'email'; template?: string; subject?: string; body?: string; recipients: unknown; relatedTo?: string; next?: string }
  | { type: 'postToFeed'; parentId: string; body: string; next?: string }
  | { type: 'submitForApproval'; recordId: string; processApiName?: string; next?: string }
  | { type: 'subflow'; flow: string; inputs?: Record<string, unknown>; outputs?: Record<string, string>; next?: string }
  | { type: 'screen'; next?: string };

export interface FlowDefinition {
  id: string;
  apiName: string;
  label: string;
  version: number;
  status: FlowStatus;
  processType: FlowProcessType;
  trigger: FlowTrigger | null;
  startNode: string | null;
  nodes: Record<string, FlowNode>;
  variables: FlowVariable[];
}

export interface FlowRunResult {
  /** Variables at the point the flow finished. */
  variables: Record<string, unknown>;
  /** Nodes visited, in order — the audit trail when a flow misbehaves. */
  path: string[];
  /** Set when a before-save flow changed the triggering record. */
  recordUpdates: Record<string, unknown>;
}
