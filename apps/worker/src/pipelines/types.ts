/**
 * Reports progress for the job currently running. Doubles as the heartbeat the
 * app's reaper watches, so long stages should call it as they advance.
 */
export type StageReporter = (
  step: number,
  totalSteps: number,
  label: string,
  detail?: string,
) => Promise<void>;
