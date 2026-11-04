// Public API of the TraceChain synthetic vertical slice (SYNTHETIC DATA ONLY; not a compliance tool).
export {
  LIMITS, SCHEMA_VERSION, RULE_VERSION, REPORT_SCHEMA_VERSION, UNIT, SYNTHETIC_LABEL, DISCLAIMER,
  REJECTION_COMPLETENESS_MESSAGE, TraceChainError,
} from './limits.js';
export { importCandidate, Workspace, WorkspaceRegistry } from './workspace.js';
export { isAcceptedSnapshot } from './validate.js';
export { traceForward, traceBackward, eventEvidence, queryRecords } from './trace.js';
export { buildReport, reportToJson, reportToCsv, parseReportCsv } from './report.js';
export { csvCell } from './csv.js';
