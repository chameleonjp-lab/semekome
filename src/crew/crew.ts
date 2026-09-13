export type CrewTask = "idle" | "carry" | "deliver" | "operate";

export interface CrewAssignment {
  actorId: string;
  task: CrewTask;
  targetCaseId?: string;
  targetTurretId?: string;
  path: Array<{ x: number; y: number }>;
  pathIndex: number;
  /** Deterministic stuck detector used to re-plan blocked routes. */
  stuckTicks?: number;
  lastPosition?: { x: number; y: number };
}
