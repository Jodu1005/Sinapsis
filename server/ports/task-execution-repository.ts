import type { WorkspaceRepositories } from './repositories'

/** The task Runtime coordinator deliberately sees only task-execution operations. */
export type TaskExecutionCoordinatorRepository = Pick<WorkspaceRepositories,
  | 'consumeTaskInput'
  | 'createMessage'
  | 'createTaskArtifact'
  | 'createTaskInput'
  | 'finishTaskExecution'
  | 'getActiveTaskForAgent'
  | 'getAgent'
  | 'getRepository'
  | 'getTask'
  | 'getTaskDetails'
  | 'inTransaction'
  | 'markTimedOut'
  | 'reclaimReturnedTask'
  | 'transitionTask'
  | 'updateTaskSession'
>
