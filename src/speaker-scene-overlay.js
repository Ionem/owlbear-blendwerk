import { normalizeSpeakers } from "./speakers.js";
import { captureCameraAnchor, restoreCameraAnchor } from "./camera-anchor.js";

// A real shared scene item is rendered by Owlbear on the Cast receiver even
// when its extension background or modals are not running (Hide Interface).
// These markers allow recovery after reloads and protect user scene items.
export const SCENE_OVERLAY_TAG = "de.horasreich.viewjump/speaker-scene-overlay-v1";
const BACKDROP = "backdrop";
const PORTRAIT = "portrait";
const FRAME = "frame";
// NOTE is an ordinary shared scene layer. POPOVER may be suppressed by
// Owlbear's Hide Interface casting mode, so never use it for cast imagery.
const LAYER = "NOTE";
const ANCHOR_METADATA_KEY = "de.horasreich.viewjump/speaker-stage-anchor-v1";

// Owlbear errors can be rejected SDK payloads, not native Errors. String({})
// would hide all useful details as "[object Object]".
export function describeSdkError(error) {
  if (typeof error === "string") return error;
  if (error == null) return String(error);
  const bits = [];
  for (const key of ["message", "code", "name", "status", "details", "cause", "errors"]) {
    const value = error[key];
    if (value == null) continue;
    if (typeof value === "string" && value.trim()) bits.push(`${key}: ${value}`);
    else if (typeof value === "number") bits.push(`${key}: ${value}`);
    else if (typeof value === "object") {
      try { bits.push(`${key}: ${JSON.stringify(value)}`); }
      catch { bits.push(`${key}: nicht serialisierbar`); }
    }
  }
  if (!bits.length) {
    try {
      const json = JSON.stringify(error, Object.getOwnPropertyNames(error));
      if (json && json !== "{}") bits.push(json);
    } catch { /* ignore */ }
  }
  return bits.join(" | ") || String(error);
}


export function portraitGeometry(anchor, image) {
  if (!anchor || !Number.isFinite(anchor.width) || !Number.isFinite(anchor.height) ||
      !Number.isFinite(anchor.scale) || anchor.scale <= 0 ||
      !Number.isFinite(anchor.center?.x) || !Number.isFinite(anchor.center?.y) ||
      !image || image.width <= 0 || image.height <= 0) {
    throw new Error("Ungültige Kamera- oder Porträtgeometrie.");
  }
  const viewportWidth = anchor.width / anchor.scale;
  const viewportHeight = anchor.height / anchor.scale;
  const factor = Math.min(0.94 * viewportHeight / image.height,
    0.94 * viewportWidth / image.width);
  const worldWidth = image.width * factor;
  const worldHeight = image.height * factor;
  const center = anchor.center;
  const margin = Math.max(7 / anchor.scale, Math.min(viewportWidth, viewportHeight) * 0.008);
  return {
    scale: { x: factor, y: factor },
    position: { x: center.x - worldWidth / 2, y: center.y - worldHeight / 2 },
    frame: { position: { x: center.x - worldWidth / 2 - margin,
      y: center.y - worldHeight / 2 - margin },
      width: worldWidth + margin * 2, height: worldHeight + margin * 2 },
    background: {
      width: viewportWidth * 8, height: viewportHeight * 8,
      position: { x: center.x - viewportWidth * 4, y: center.y - viewportHeight * 4 },
    },
  };
}

function imageMime(url) {
  const pathname = new URL(url).pathname.toLowerCase();
  return pathname.endsWith(".png") ? "image/png" :
    pathname.endsWith(".webp") ? "image/webp" : "image/jpeg";
}

/**
 * A GM-controlled, ephemeral shared stage. Does not move the camera or alter
 * other scene items. Serialized updates prevent rapid pad presses from
 * stranding old items. Assumes the GM background runs while scene is ready.
 */
export class SpeakerSceneOverlay {
  constructor({ items, viewport, sceneGrid, userId, report = () => {} }) {
    this.items = items;
    this.viewport = viewport;
    this.sceneGrid = sceneGrid;
    this.userId = userId;
    this.report = report;
    this.queue = Promise.resolve();
    this.activeUrl = null;
    this.stageAnchor = null;
    this.lastItems = [];
  }

  /** Reassert the recorded view AFTER Owlbear has processed the new scene
   * item. Without this, a delayed native cast camera animation can overwrite
   * the camera just before Sync View samples it.
   */
  async reassertCamera() {
    if (this.stageAnchor) return restoreCameraAnchor(this.viewport, this.stageAnchor);
    return false;
  }

  update(raw) {
    const state = normalizeSpeakers(raw);
    this.queue = this.queue.catch(() => {}).then(() => this.apply(state));
    return this.queue;
  }

  async ownedItems() {
    return this.items.getItems((item) =>
      [BACKDROP, FRAME, PORTRAIT].includes(item.metadata?.[SCENE_OVERLAY_TAG]));
  }

  async clear() {
    const existing = await this.ownedItems();
    // Restore the original map camera on hide rather than letting a zoom
    // introduced during the presentation carry into the next portrait.
    const backdrop = existing.find(item =>
      item.metadata?.[SCENE_OVERLAY_TAG] === BACKDROP);
    const anchor = this.stageAnchor ?? backdrop?.metadata?.[ANCHOR_METADATA_KEY];
    if (existing.length) await this.items.deleteItems(existing.map(item => item.id));
    this.lastItems = [];
    this.activeUrl = null;
    this.stageAnchor = null;
    if (anchor) await restoreCameraAnchor(this.viewport, anchor);
  }

  async apply(state) {
    const image = state.active ? state.images[state.active] : null;
    if (!image) {
      await this.clear();
      this.report({ type: "scene-overlay-close" });
      return;
    }

    const existing = await this.ownedItems();
    const backdrop = existing.find((item) => item.metadata?.[SCENE_OVERLAY_TAG] === BACKDROP);
    const portrait = existing.find((item) => item.metadata?.[SCENE_OVERLAY_TAG] === PORTRAIT);
    const previousFrame = existing.find((item) => item.metadata?.[SCENE_OVERLAY_TAG] === FRAME);
    // Reuse existing items if possible, and do not jump or recenter on A -> B.
    // Remove obsolete POPOVER items from 0.6.3 even if the same portrait
    // is still active. Otherwise the legacy state would silently persist.
    if (backdrop && previousFrame && portrait && existing.length === 3 &&
        backdrop.layer === LAYER && previousFrame.layer === LAYER && portrait.layer === LAYER &&
        portrait.textItemType === "LABEL" && portrait.text?.type === "PLAIN" && typeof portrait.text?.plainText === "string") {
      if (portrait.image?.url !== image.url) {
        // The original world-space stage stays fixed for the whole A/B
        // conversation. Never remeasure a potentially changing viewport on
        // each speaker toggle: otherwise the Cast can appear to zoom/crop.
        const anchor = this.stageAnchor ?? backdrop.metadata?.[ANCHOR_METADATA_KEY]
          ?? await captureCameraAnchor(this.viewport);
        this.stageAnchor = anchor;
        const geometry = portraitGeometry(anchor, image);
        await this.items.updateItems([portrait.id, backdrop.id, previousFrame.id], (draft) => {
          for (const item of draft) {
            if (item.id === backdrop.id) {
              item.position = geometry.background.position;
              item.width = geometry.background.width;
              item.height = geometry.background.height;
            } else if (item.id === previousFrame.id) {
              item.position = geometry.frame.position;
              item.width = geometry.frame.width;
              item.height = geometry.frame.height;
            } else if (item.id === portrait.id) {
              item.image = { url: image.url, width: image.width,
                height: image.height, mime: image.mime ?? imageMime(image.url) };
              item.scale = geometry.scale;
              item.position = geometry.position;
              item.name = `Blendwerk Porträt ${state.active}`;
            }
          }
        });
      }
      this.stageAnchor ??= backdrop.metadata?.[ANCHOR_METADATA_KEY]
        ?? await captureCameraAnchor(this.viewport);
      this.activeUrl = image.url;
      // A changed image or the cast renderer can leave the master view
      // zoomed. Always reapply the session's original camera before sync.
      await restoreCameraAnchor(this.viewport, this.stageAnchor);
      this.report({ type: "scene-overlay-open", message: state.active });
      return;
    }

    // Partial state after crash or an older release: safely remove only own items.
    if (existing.length) await this.items.deleteItems(existing.map((item) => item.id));
    const anchor = await captureCameraAnchor(this.viewport);
    const geometry = portraitGeometry(anchor, image);
    const dpi = await this.sceneGrid.getDpi();
    const common = (kind, zIndex) => ({
      id: globalThis.crypto.randomUUID(),
      name: `Blendwerk ${kind}`,
      createdUserId: this.userId,
      lastModifiedUserId: this.userId,
      lastModified: new Date().toISOString(),
      visible: true,
      locked: true,
      rotation: 0,
      zIndex,
      layer: LAYER,
      scale: { x: 1, y: 1 },
      disableHit: true,
      disableAutoZIndex: true,
      metadata: { [SCENE_OVERLAY_TAG]: kind },
    });
    // Plain SDK Item records avoid shipping a second SDK bundle. The SDK
    // scene API accepts serializable Item data from the public schema.
    const background = {
      ...common(BACKDROP, 1000000),
      metadata: { [SCENE_OVERLAY_TAG]: BACKDROP, [ANCHOR_METADATA_KEY]: anchor },
      type: "SHAPE",
      shapeType: "RECTANGLE",
      position: geometry.background.position,
      width: geometry.background.width,
      height: geometry.background.height,
      style: { fillColor: "#07120e", fillOpacity: 1,
        strokeColor: "#07120e", strokeOpacity: 0,
        strokeWidth: 0, strokeDash: [] },
    };
    // Gold frame is part of the actual presentation, not a test marker.
    const frame = {
      ...common(FRAME, 1000001),
      type: "SHAPE", shapeType: "RECTANGLE",
      position: geometry.frame.position,
      width: geometry.frame.width, height: geometry.frame.height,
      style: { fillColor: "#8d6438", fillOpacity: 1,
        strokeColor: "#d4b776", strokeOpacity: 1,
        strokeWidth: 3, strokeDash: [] },
    };
    const foreground = {
      ...common(PORTRAIT, 1000002),
      type: "IMAGE",
      name: `Blendwerk Porträt ${state.active}`,
      position: geometry.position,
      scale: geometry.scale,
      image: { url: image.url, width: image.width, height: image.height,
        mime: image.mime ?? imageMime(image.url) },
      grid: { dpi, offset: { x: 0, y: 0 } },
      // An IMAGE has more required fields than a SHAPE. The previous version
      // omitted text/textItemType, so the renderer could fail while addItems
      // still returned an item in the scene data store.
      // Match the complete TextContent produced by Owlbear's ImageBuilder.
      // Both richText and plainText are part of the serialized schema, even
      // when type is PLAIN; 0.6.7 omitted richText and the host rejected IMAGE.
      text: { type: "PLAIN", plainText: "",
        richText: [{ type: "paragraph", children: [{ text: "" }] }],
        width: "AUTO", height: "AUTO",
        style: { fillColor: "white", fillOpacity: 1, strokeColor: "white",
          strokeOpacity: 1, strokeWidth: 0, textAlign: "CENTER",
          textAlignVertical: "BOTTOM", fontFamily: "Roboto", fontSize: 24,
          fontWeight: 400, lineHeight: 1.5, padding: 8 } },
      textItemType: "LABEL",
    };
    // Split the already-proven SHAPE scene path from the IMAGE path. An IMAGE
    // validation failure must not hide the successful shape insertion.
    try {
      await this.items.addItems([background, frame]);
    } catch (error) {
      const details = describeSdkError(error);
      this.report({ type: "scene-overlay-error", message: `Bühnenformen: ${details}` });
      throw new Error(`Cast-Bühne konnte keine Formen anlegen: ${details}`);
    }
    try {
      await this.items.addItems([foreground]);
    } catch (error) {
      const details = describeSdkError(error);
      this.report({ type: "scene-overlay-error", message: `Bildobjekt: ${details}` });
      // Clean up partial stage objects after image validation failure.
      const ids = [background.id, frame.id];
      globalThis.setTimeout(() => {
        void this.items.deleteItems(ids).catch((cleanupError) =>
          this.report({ type: "scene-overlay-error",
            message: `Aufräumen: ${describeSdkError(cleanupError)}` }));
      }, 1000);
      throw new Error(`Cast-Bildobjekt abgewiesen: ${details}`);
    }
    const check = await this.ownedItems();
    const found = check.filter((x) => x.layer === LAYER).length;
    if (found !== 3) {
      throw new Error(`Cast-Porträt nicht korrekt in Owlbear gespeichert: ${found}/3 NOTE-Objekte`);
    }
    const checkedPortrait = check.find(x => x.metadata?.[SCENE_OVERLAY_TAG] === PORTRAIT);
    if (checkedPortrait?.type !== "IMAGE" ||
        checkedPortrait.image?.url !== image.url) {
      throw new Error("Owlbear hat das Bildobjekt nicht vollständig übernommen.");
    }
    this.stageAnchor = anchor;
    this.activeUrl = image.url;
    await restoreCameraAnchor(this.viewport, anchor);
    this.report({ type: "scene-overlay-open",
      message: `Porträt ${state.active} auf Meister und Cast angezeigt.` });
  }
}
