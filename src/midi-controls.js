/** MIDI/controller maths without Owlbear or hardware dependencies. */
export function nextZoomScale(scale, delta) {
  if (!Number.isFinite(scale) || scale <= 0 || !Number.isFinite(delta)) return null;
  // Preserve the entire MIDI CC movement, including large jumps between polls.
  return Math.min(12, Math.max(0.08, scale * Math.exp(delta * 0.018)));
}

/** Keep the same world point at the centre of the screen while zooming. */
export function centeredZoomPosition(position, oldScale, newScale, width, height) {
  if (!position || ![position.x, position.y, oldScale, newScale, width, height]
    .every(Number.isFinite) || oldScale <= 0 || newScale <= 0) return null;
  const centre = { x: width / 2, y: height / 2 };
  const ratio = newScale / oldScale;
  return {
    x: centre.x + (position.x - centre.x) * ratio,
    y: centre.y + (position.y - centre.y) * ratio,
  };
}

/** Relative pan: clockwise X reveals the right; clockwise Y reveals above.
 * Viewport position is a screen offset, hence the sign reversal for X.
 * Eight screen pixels per CC step allow roughly one screen per full sweep.
 */
export function pannedViewportPosition(position, axis, delta, pixelsPerStep = 8) {
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y) ||
      ![delta, pixelsPerStep].every(Number.isFinite) ||
      pixelsPerStep <= 0 || !["x", "y"].includes(axis)) return null;
  return axis === "x"
    ? { x: position.x - delta * pixelsPerStep, y: position.y }
    : { x: position.x, y: position.y + delta * pixelsPerStep };
}

export function normalizedDegrees(angle) {
  return ((angle % 360) + 360) % 360;
}

/**
 * Track absolute MIDI CC values relative to the selected token's initial angle.
 * The first movement merely picks up that angle (no jump). Every subsequent
 * position is deterministic, even if intermediate MIDI messages are dropped.
 */
export class TokenRotationFromPotentiometer {
  constructor() { this.reset(); }

  reset() {
    this.tokenId = null;
    this.startValue = null;
    this.startAngle = null;
  }

  resolve(tokenId, actualAngle, value) {
    if (typeof tokenId !== "string" || !Number.isInteger(value) ||
        value < 0 || value > 127 || !Number.isFinite(actualAngle)) return null;
    if (this.tokenId !== tokenId || this.startValue === null) {
      this.tokenId = tokenId;
      this.startValue = value;
      this.startAngle = normalizedDegrees(actualAngle);
      return null;
    }
    return normalizedDegrees(this.startAngle + (value - this.startValue) * 360 / 127);
  }
}

/** Compress a MIDI burst while retaining the order around view/button actions. */
export function coalesceMidiCommands(commands) {
  const result = [];
  for (const command of commands) {
    if (!command || typeof command !== "object") continue;
    const last = result[result.length - 1];
    if (["zoom_delta", "pan_x_delta", "pan_y_delta"].includes(command.type) &&
        last?.type === command.type) {
      last.delta += command.delta;
    } else if (command.type === "rotation_value" && last?.type === "rotation_value") {
      last.value = command.value;
    } else {
      result.push({ ...command });
    }
  }
  return result;
}
