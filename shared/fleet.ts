import config from "./fleet.json" with { type: "json" };

/** Shared default and limits; actual session totals always come from scoped state. */
export const FLEET = config;
export const ROWS = Math.ceil(FLEET.drones / FLEET.columns);
const SPAN = (FLEET.columns - 1) * FLEET.spacing;
export const ROW_SPACING = SPAN / Math.max(1, ROWS - 1);
/** Stable ID slots, centered at the scene origin. Never depend on discovery order. */
export const slot = (id: number) => [
  ((id - 1) % FLEET.columns) * FLEET.spacing - SPAN / 2,
  Math.floor((id - 1) / FLEET.columns) * ROW_SPACING - SPAN / 2,
];
