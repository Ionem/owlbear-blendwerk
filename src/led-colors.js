import { DIRECT_SLOT_COUNT } from "./constants.js";

/** The five direct views: dim = available; bright = active; dark = empty.
 * Pads 6–8 are reserved for independent functions on the Owlbear bank.
 */
export function ledColorsFromState(state) {
  return Array.from({ length: DIRECT_SLOT_COUNT }, (_, index) => {
    if (index >= 5) return "off";
    const targetId = state?.slots?.[index];
    if (!targetId) return "off";
    return state.mode === "target" && targetId === state.activeId
      ? "green_full" : "green_low";
  });
}
