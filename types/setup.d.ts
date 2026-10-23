// The types of /setup-project, by the names the contract in index.d.ts gives them.
import type { SetupDocIssue, SetupDocIssueKind, SetupStepId, SetupStepState, SetupRun, SetupFinding, SetupJudge } from '.'

export type DocIssue = SetupDocIssue
export type DocIssueKind = SetupDocIssueKind
export type StepId = SetupStepId
export type StepState = SetupStepState
export type Run = SetupRun
export type Finding = SetupFinding
export type Judge = SetupJudge
