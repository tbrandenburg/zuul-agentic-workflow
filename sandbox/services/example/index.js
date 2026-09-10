import { add } from "./lib/math.js";

/**
 * Entry point of the tiny example service (Phase 4 sandbox target repo).
 * @returns {number}
 */
export function main() {
  return add(2, 3);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  console.log(main());
}
