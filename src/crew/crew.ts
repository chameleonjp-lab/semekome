export type CrewTask = "idle" | "carry" | "deliver" | "operate" | "patrol" | "defend" | "retreat";

export interface CrewAssignment {
  actorId: string;
  task: CrewTask;
  targetCaseId?: string;
  targetTurretId?: string;
  path: Array<{ x: number; y: number }>;
  pathIndex: number;
  /** Physical enemy movement target; never used as a public object id. */
  targetRoomId?: string;
  targetActorId?: string;
  targetPosition?: { x: number; y: number };
  /** Deterministic stuck detector used to re-plan blocked routes. */
  stuckTicks?: number;
  lastPosition?: { x: number; y: number };
}
