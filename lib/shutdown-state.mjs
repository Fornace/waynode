/**
 * Shutdown state shared by the HTTP layer and the drain loop. While draining,
 * new turns are rejected with a friendly 503; running agents get the drain
 * window to settle before the process exits (recovery continuation catches
 * whatever is still in flight).
 */

let draining = false;

export function isDraining() {
  return draining;
}

export function beginDrain() {
  draining = true;
}
