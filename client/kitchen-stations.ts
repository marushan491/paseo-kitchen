export const kitchenStations = [
  {
    id: "head",
    title: "Head Chef",
    purpose: "Coordination",
    description: "Coordinates the mission, answers team questions and dispatches the next work.",
    idle: "Your mission’s coordinator appears here when work starts.",
    x: 0,
    z: -4,
  },
  {
    id: "plan",
    title: "Plan",
    purpose: "Requirements & tasks",
    description:
      "Turns the outcome into scoped tasks, dependencies and observable success criteria.",
    idle: "Planning begins when a mission needs its work scoped.",
    x: -4,
    z: -1,
  },
  {
    id: "build",
    title: "Build",
    purpose: "Implementation",
    description: "Builds the implementation in an isolated worktree and records evidence.",
    idle: "Implementation starts after a task is ready.",
    x: 0,
    z: 0,
  },
  {
    id: "review",
    title: "Review",
    purpose: "Code review & improvement",
    description: "Reviews and improves the implementation before independent verification.",
    idle: "Review becomes active after implementation is ready.",
    x: 4,
    z: -1,
  },
  {
    id: "verify",
    title: "Verify",
    purpose: "Tests & evidence",
    description:
      "Independently checks the implementation and its evidence against success criteria.",
    idle: "Verification begins after review, with evidence tied to the actual result.",
    x: -4,
    z: 3.5,
  },
  {
    id: "integrate",
    title: "Integrate",
    purpose: "Combine verified work",
    description: "Combines verified results and checks the integrated checkout.",
    idle: "Integration waits for verified scoped tasks.",
    x: 0,
    z: 5,
  },
  {
    id: "final",
    title: "Final verification",
    purpose: "Acceptance candidate",
    description: "Independently verifies the combined result before your acceptance.",
    idle: "The combined result arrives here before human acceptance.",
    x: 4,
    z: 3.5,
  },
] as const;
export type KitchenStationId = (typeof kitchenStations)[number]["id"];
export function stageForRole(
  role: string,
  _phase: string,
  finalVerification = false,
): KitchenStationId {
  const value = role.toLowerCase();
  if (value === "head chef") return "head";
  if (value === "po" || value === "planner" || value === "analyst" || value === "gardener")
    return "plan";
  if (value === "developer" || value === "implementer") return "build";
  if (value === "reviewer") return "review";
  if (value === "verifier" || value === "tester") return finalVerification ? "final" : "verify";
  if (value === "integrator") return "integrate";
  return "head";
}
export function stationPosition(id: KitchenStationId, seat = 0) {
  const station = kitchenStations.find((value) => value.id === id)!;
  return {
    x: station.x + ((seat % 3) - 1) * 0.62,
    z: station.z + 1.45 + Math.floor(seat / 3) * 0.58,
  };
}
export function clampZoom(value: number) {
  return Math.max(60, Math.min(180, Math.round(value)));
}
export function travelDuration(distance: number) {
  return Math.max(400, Math.min(900, distance * 90));
}
export function travelPosition(
  from: { x: number; z: number },
  to: { x: number; z: number },
  progress: number,
  reducedMotion: boolean,
) {
  if (reducedMotion) return to;
  const t = Math.max(0, Math.min(1, progress));
  const eased = t * t * (3 - 2 * t);
  return { x: from.x + (to.x - from.x) * eased, z: from.z + (to.z - from.z) * eased };
}
