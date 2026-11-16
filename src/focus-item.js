/** Fit a single selected Owlbear item to the current GM presentation viewport. */
export function validItemBounds(bounds) {
  return Boolean(bounds &&
    Number.isFinite(bounds.min?.x) && Number.isFinite(bounds.min?.y) &&
    Number.isFinite(bounds.max?.x) && Number.isFinite(bounds.max?.y) &&
    Number.isFinite(bounds.center?.x) && Number.isFinite(bounds.center?.y) &&
    Number.isFinite(bounds.width) && bounds.width > 0 &&
    Number.isFinite(bounds.height) && bounds.height > 0);
}

export async function focusSelectedItem({ getSelection, getItemBounds, animateToBounds }) {
  const selection = await getSelection();
  if (!Array.isArray(selection) || selection.length !== 1) {
    throw new Error("Bitte genau ein Bild oder Token auswählen, um darauf zu fokussieren.");
  }
  const bounds = await getItemBounds(selection);
  if (!validItemBounds(bounds)) {
    throw new Error("Das ausgewählte Objekt hat keinen gültigen Bildausschnitt.");
  }
  await animateToBounds(bounds);
}
