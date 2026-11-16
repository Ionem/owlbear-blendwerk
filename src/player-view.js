/**
 * Optional, explicit GM -> player presentation camera synchronization.
 * Positions in Owlbear's ViewportTransform are screen-space offsets, not
 * portable locations for monitors with different usable viewport sizes.
 * Send the world centre and the source viewport dimensions instead.
 */

const delay = (ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms));

export function isCameraAnchor(anchor) {
  return Boolean(anchor && Number.isFinite(anchor.center?.x) &&
    Number.isFinite(anchor.center?.y) && Number.isFinite(anchor.scale) &&
    anchor.scale > 0 && Number.isFinite(anchor.width) && anchor.width > 0 &&
    Number.isFinite(anchor.height) && anchor.height > 0);
}

export async function captureCameraAnchor(viewport) {
  const [position, scale, width, height] = await Promise.all([
    viewport.getPosition(), viewport.getScale(),
    viewport.getWidth(), viewport.getHeight(),
  ]);
  const anchor = {
    center: {
      x: (width / 2 - position.x) / scale,
      y: (height / 2 - position.y) / scale,
    },
    scale, width, height,
  };
  if (!isCameraAnchor(anchor)) throw new Error("Ungültige GM-Kameraposition für den Spielerabgleich.");
  return anchor;
}

export function cameraForViewport(anchor, width, height) {
  if (!isCameraAnchor(anchor) || !Number.isFinite(width) || width <= 0 ||
      !Number.isFinite(height) || height <= 0) return null;
  // Fit the GM's visible world rectangle into the viewer's aspect ratio.
  // Unlike copying the GM's pixel offset, this preserves the world centre.
  const scale = anchor.scale * Math.min(width / anchor.width, height / anchor.height);
  const view = {
    scale,
    position: {
      x: width / 2 - anchor.center.x * scale,
      y: height / 2 - anchor.center.y * scale,
    },
  };
  return Number.isFinite(view.position.x) && Number.isFinite(view.position.y) &&
    Number.isFinite(view.scale) && view.scale > 0 ? view : null;
}

export function matchesCamera(actual, expected) {
  return actual && expected &&
    Math.abs(actual.position.x - expected.position.x) <= 0.5 &&
    Math.abs(actual.position.y - expected.position.y) <= 0.5 &&
    Math.abs(actual.scale - expected.scale) <= Math.max(0.00001, expected.scale * 0.0001);
}

/**
 * We cannot disable Owlbear's regular Sync View, so check whether it has
 * overwritten the corrected player viewport after its own network update.
 * Cancellation prevents an older view from being restored after a new press.
 */
export async function applyCameraOnPlayer(viewport, anchor, isCurrent = () => true,
  wait = delay) {
  const [width, height] = await Promise.all([viewport.getWidth(), viewport.getHeight()]);
  const expected = cameraForViewport(anchor, width, height);
  if (!expected) throw new Error("Die Spielerbildschirm-Größe ist ungültig.");
  if (!isCurrent()) return false;

  await viewport.setScale(expected.scale);
  if (!isCurrent()) return false;
  await viewport.setPosition(expected.position);

  for (const milliseconds of [250, 450]) {
    await wait(milliseconds);
    if (!isCurrent()) return false;
    const [position, scale] = await Promise.all([
      viewport.getPosition(), viewport.getScale(),
    ]);
    if (!isCurrent()) return false;
    if (matchesCamera({ position, scale }, expected)) continue;

    // The native Sync View has changed the player camera in the meantime.
    if (Math.abs(scale - expected.scale) >
        Math.max(0.00001, expected.scale * 0.0001)) {
      await viewport.setScale(expected.scale);
    }
    if (!isCurrent()) return false;
    await viewport.setPosition(expected.position);
  }

  if (!isCurrent()) return false;
  const [position, scale] = await Promise.all([
    viewport.getPosition(), viewport.getScale(),
  ]);
  if (!matchesCamera({ position, scale }, expected)) {
    throw new Error("Der Spielerclient hat die korrigierte Ansicht nicht übernommen.");
  }
  return true;
}

/** Serialize incoming messages; the latest requested view wins. */
export class PlayerViewportFollower {
  constructor({ viewport, verifySender, isSceneReady, acknowledge,
    onError = console.error, wait = delay }) {
    this.viewport = viewport;
    this.verifySender = verifySender;
    this.isSceneReady = isSceneReady;
    this.acknowledge = acknowledge;
    this.onError = onError;
    this.wait = wait;
    this.pending = null;
    this.running = false;
    this.generation = 0;
  }

  cancel() {
    this.generation += 1;
    this.pending = null;
  }

  receive(data, connectionId) {
    if (data?.type !== "camera" || typeof data.epoch !== "string" ||
        !Number.isSafeInteger(data.sequence) || data.sequence < 1 ||
        !isCameraAnchor(data.anchor) || typeof connectionId !== "string") return;
    this.generation += 1;
    this.pending = { data, connectionId, generation: this.generation };
    void this.drain();
  }

  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending) {
        const task = this.pending;
        this.pending = null;
        const isCurrent = () => task.generation === this.generation;
        try {
          if (!(await this.verifySender(task.connectionId)) || !isCurrent()) continue;
          if (!(await this.isSceneReady()) || !isCurrent()) continue;
          const success = await applyCameraOnPlayer(
            this.viewport, task.data.anchor, isCurrent, this.wait,
          );
          if (success && isCurrent()) {
            await this.acknowledge({ type: "ack", epoch: task.data.epoch,
              sequence: task.data.sequence, status: "ok",
              diagnostics: Boolean(task.data.diagnostics) });
          }
        } catch (error) {
          this.onError(error);
          if (isCurrent()) {
            try {
              await this.acknowledge({ type: "ack", epoch: task.data.epoch,
                sequence: task.data.sequence, status: "error" });
            } catch (ackError) {
              this.onError(ackError);
            }
          }
        }
      }
    } finally {
      this.running = false;
    }
  }
}
