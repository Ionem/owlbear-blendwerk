/** Capture the unmodified GM map view before placing an ephemeral portrait stage.
 * The viewport API uses screen offsets and a scale, not a shared cast camera.
 */
export async function captureCameraAnchor(viewport) {
  const [position, scale, width, height] = await Promise.all([
    viewport.getPosition(), viewport.getScale(),
    viewport.getWidth(), viewport.getHeight(),
  ]);
  if (!Number.isFinite(position?.x) || !Number.isFinite(position?.y) ||
      !Number.isFinite(scale) || scale <= 0 ||
      !Number.isFinite(width) || width <= 0 ||
      !Number.isFinite(height) || height <= 0) {
    throw new Error("Ungültige Meisterkamera für die Porträtanzeige.");
  }
  return { center: { x: (width / 2 - position.x) / scale,
    y: (height / 2 - position.y) / scale }, scale, width, height };
}

/** Bring the GM camera back to the view recorded BEFORE the stage was created.
 * This is crucial: after a cast zoom anomaly the next portrait must not treat
 * the anomalous zoom as the new baseline (which caused cumulative cropping).
 * Width/height are read again so resizing the Owlbear panel does not shift the
 * world center of the recorded map view.
 */
export async function restoreCameraAnchor(viewport, anchor) {
  if (!Number.isFinite(anchor?.center?.x) || !Number.isFinite(anchor?.center?.y) ||
      !Number.isFinite(anchor?.scale) || anchor.scale <= 0) {
    throw new Error("Gespeicherte Kartenansicht ist ungültig.");
  }
  const [scale, position, width, height] = await Promise.all([
    viewport.getScale(), viewport.getPosition(),
    viewport.getWidth(), viewport.getHeight(),
  ]);
  if (!Number.isFinite(width) || !Number.isFinite(height) ||
      width <= 0 || height <= 0) throw new Error("Ungültige Bildschirmgröße.");
  const expected = {
    x: width / 2 - anchor.center.x * anchor.scale,
    y: height / 2 - anchor.center.y * anchor.scale,
  };
  const changeScale = Math.abs(scale - anchor.scale) > Math.max(0.0001, anchor.scale * 0.0001);
  const changePosition = Math.abs(position.x - expected.x) > 0.5 ||
    Math.abs(position.y - expected.y) > 0.5;
  // Set scale before position: an Owlbear zoom can shift the screen offset.
  if (changeScale) await viewport.setScale(anchor.scale);
  if (changePosition || changeScale) await viewport.setPosition(expected);
  return changeScale || changePosition;
}
