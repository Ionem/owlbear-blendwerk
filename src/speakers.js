/** Seven portrait slots, stored in the same room metadata as the working 0.6.10 release.
 * Legacy A/B portraits migrate automatically to slots 6/7, without changing
 * existing user assignments until the next intentional action.
 */
export const SPEAKER_METADATA_KEY = "de.horasreich.viewjump/speakers-v1";
export const PORTRAIT_SLOT_COUNT = 7;

export function validPortraitSlot(slot) {
  return Number.isInteger(slot) && slot >= 1 && slot <= PORTRAIT_SLOT_COUNT;
}

export function validSpeakerImage(image) {
  if (!image || typeof image !== "object" || typeof image.name !== "string" ||
      typeof image.url !== "string") return false;
  try {
    const url = new URL(image.url);
    return url.protocol === "https:" && image.name.length <= 180 &&
      Number.isFinite(image.width) && image.width > 0 &&
      Number.isFinite(image.height) && image.height > 0;
  } catch { return false; }
}

function imageRecord(image) {
  return { name: image.name, url: image.url,
    width: image.width, height: image.height,
    ...(typeof image.mime === "string" && image.mime.startsWith("image/")
      ? { mime: image.mime } : {}) };
}

export function normalizeSpeakers(raw) {
  const data = raw && typeof raw === "object" ? raw : {};
  const images = {};
  for (let slot = 1; slot <= PORTRAIT_SLOT_COUNT; slot += 1) {
    // Existing A/B images were originally assigned to hardware pads 6 and 7.
    const legacy = slot === 6 ? data.images?.A : slot === 7 ? data.images?.B : null;
    const entry = data.images?.[slot] ?? legacy;
    images[slot] = validSpeakerImage(entry) ? imageRecord(entry) : null;
  }
  const legacyActive = data.active === "A" ? 6 : data.active === "B" ? 7 : null;
  const proposed = validPortraitSlot(data.active) ? data.active : legacyActive;
  const active = proposed && images[proposed] ? proposed : null;
  return { images, active };
}

export function chooseSpeaker(raw, slot) {
  if (!validPortraitSlot(slot)) throw new Error("Ungültiger Porträtplatz (1–7).");
  const state = normalizeSpeakers(raw);
  if (!state.images[slot]) throw new Error(`Bitte zuerst ein Bild für Pad ${slot} wählen.`);
  return { ...state, active: state.active === slot ? null : slot };
}

export function changeSpeakerImage(raw, slot, image) {
  if (!validPortraitSlot(slot)) throw new Error("Ungültiger Porträtplatz (1–7).");
  if (!validSpeakerImage(image)) throw new Error("Kein gültiges Owlbear-Bibliotheksbild (HTTPS).");
  const state = normalizeSpeakers(raw);
  return { ...state, images: { ...state.images, [slot]: imageRecord(image) } };
}

export function speakerPadColors(raw) {
  const state = normalizeSpeakers(raw);
  return Array.from({ length: PORTRAIT_SLOT_COUNT }, (_, index) => {
    const slot = index + 1;
    return !state.images[slot] ? "off" : state.active === slot ? "amber_full" : "amber_low";
  });
}

/** Skip redundant room-state notifications that are unrelated to portraits. */
export function visiblePortraitKey(raw) {
  const state = normalizeSpeakers(raw);
  const image = state.active ? state.images[state.active] : null;
  return image ? `${state.active}:${image.url}:${image.width}:${image.height}` : "none";
}
