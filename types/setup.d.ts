// The types of /setup-project, by the names the contract in index.d.ts gives them.
import type { SetupBaseline, SetupChecks, SetupDocIssue, SetupDocIssueKind, SetupFinding, SetupGate, SetupGateFailure, SetupJudge, SetupRun, SetupRunCommands, SetupStepId, SetupStepState, SetupTerm, SetupTermCheck, SetupTermVerdict } from '.'

export type DocIssue = SetupDocIssue
export type DocIssueKind = SetupDocIssueKind
export type StepId = SetupStepId
export type StepState = SetupStepState
export type Run = SetupRun
export type Finding = SetupFinding
export type Judge = SetupJudge
export type Term = SetupTerm
export type TermCheck = SetupTermCheck
export type TermVerdict = SetupTermVerdict
export type Checks = SetupChecks
export type RunCommands = SetupRunCommands
export type Gate = SetupGate
export type GateFailure = SetupGateFailure
export type Baseline = SetupBaseline
