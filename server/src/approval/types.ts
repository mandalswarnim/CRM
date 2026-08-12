import type { CriteriaFilter } from '../automation/criteria.js';
import type { WorkflowAction } from '../automation/workflow.js';

export type ApproverType = 'user' | 'manager' | 'queue' | 'role';

export interface ApprovalStep {
  name: string;
  approverType: ApproverType;
  /** User id, queue (group) id, or role id, depending on approverType. */
  approverId?: string;
  /** Step is skipped when the record does not meet these. */
  criteria?: CriteriaFilter[];
  /** Every assignee must approve, rather than the first response deciding. */
  unanimity?: boolean;
  /** Actions fired when this step is approved or rejected. */
  approveActions?: WorkflowAction[];
  rejectActions?: WorkflowAction[];
}

export interface ApprovalProcess {
  id: string;
  objectApi: string;
  apiName: string;
  label: string;
  active: boolean;
  entryCriteria: CriteriaFilter[] | null;
  entryFormula: string | null;
  lockRecord: boolean;
  allowRecall: boolean;
  steps: ApprovalStep[];
  initialSubmitActions: WorkflowAction[];
  finalApproveActions: WorkflowAction[];
  finalRejectActions: WorkflowAction[];
  recallActions: WorkflowAction[];
}

export type WorkItemStatus = 'Pending' | 'Approved' | 'Rejected' | 'Recalled';

export interface ApprovalWorkItem {
  id: string;
  processId: string;
  objectApi: string;
  recordId: string;
  stepIndex: number;
  stepName: string | null;
  status: WorkItemStatus;
  assignedTo: string;
  submittedBy: string;
  submittedDate: string;
  completedDate: string | null;
  actorId: string | null;
  comments: Array<{ actorId: string; comment: string; at: string }>;
}

export interface SubmitResult {
  processId: string;
  workItemIds: string[];
  status: 'Pending' | 'Approved';
  /** The step the record now sits at, or null once fully approved. */
  stepName: string | null;
}

export interface DecisionResult {
  status: 'Pending' | 'Approved' | 'Rejected';
  stepName: string | null;
  workItemIds: string[];
}
