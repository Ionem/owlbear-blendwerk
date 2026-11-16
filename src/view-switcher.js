/**
 * Kamera-Navigation ohne Owlbear-Abhaengigkeit.
 * Jede benannte Ansicht ist ein fester, dauerhafter Kamera-Anker.
 * Freies Zoomen oder Schwenken aendert diese Anker NIE automatisch.
 */
import { DIRECT_SLOT_COUNT } from "./constants.js";

export function validView(view) {
  return Boolean(
    view && Number.isFinite(view.position?.x) &&
    Number.isFinite(view.position?.y) &&
    Number.isFinite(view.scale) && view.scale > 0,
  );
}

function copyView(view) {
  return { position: { x: view.position.x, y: view.position.y }, scale: view.scale };
}

const delay = (milliseconds) => new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));

export function viewsMatch(actual, expected) {
  return validView(actual) && validView(expected) &&
    Math.abs(actual.position.x - expected.position.x) <= 0.5 &&
    Math.abs(actual.position.y - expected.position.y) <= 0.5 &&
    Math.abs(actual.scale - expected.scale) <= Math.max(0.00001, expected.scale * 0.0001);
}

/**
 * Owlbear has no non-animated atomic setter for position and scale.
 * Set scale first, then position (never concurrently), and verify that both
 * values stay put after the next rendering cycles. A delayed scale update must
 * not silently leave the camera above/beside its saved target.
 */
export async function applyFixedView(viewport, expected, wait = delay) {
  let actual = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!actual || Math.abs(actual.scale - expected.scale) >
        Math.max(0.00001, expected.scale * 0.0001)) {
      await viewport.setScale(expected.scale);
    }
    await viewport.setPosition(expected.position);

    await wait(70);
    const [position, scale] = await Promise.all([
      viewport.getPosition(), viewport.getScale(),
    ]);
    actual = { position, scale };
    if (viewsMatch(actual, expected)) {
      // Some browsers apply a deferred viewport update one frame later.
      await wait(90);
      const [latePosition, lateScale] = await Promise.all([
        viewport.getPosition(), viewport.getScale(),
      ]);
      actual = { position: latePosition, scale: lateScale };
      if (viewsMatch(actual, expected)) return;
    }
  }
  throw new Error("Owlbear hat die feste Kameraansicht nicht zuverlässig übernommen.");
}

/**
 * Sync View sends viewport changes to a separate player renderer. Owlbear can
 * acknowledge both setters on the GM client while the player still applies
 * the position against its *previous* scale (and possibly another screen
 * size). A second press on the same saved view fixes the player's position.
 * Re-send that final position once, after the first sync has had time to
 * settle. There is no camera animation and the GM's view doesn't change.
 * This intentionally makes no claim that we can read the remote viewport.
 */
export async function reinforceSyncedPosition(viewport, expected, wait = delay) {
  await wait(300);
  await viewport.setPosition(expected.position);

  // Re-check the GM viewport in case a delayed scale event shifted it again.
  await wait(90);
  const [position, scale] = await Promise.all([
    viewport.getPosition(), viewport.getScale(),
  ]);
  if (!viewsMatch({ position, scale }, expected)) {
    await applyFixedView(viewport, expected, wait);
  }
}

function normalizeTargets(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  return raw.flatMap((item) => {
    const id = typeof item?.id === "string" ? item.id.trim() : "";
    const name = typeof item?.name === "string" ? item.name.trim() : "";
    if (!id || !name || !validView(item.view) || seen.has(id)) return [];
    seen.add(id);
    return [{ id, name, view: copyView(item.view) }];
  });
}

function normalizeSlots(raw, targets) {
  const ids = new Set(targets.map((target) => target.id));
  // Szenen aus 0.2.1: bisherige Reihenfolge einmalig als Direktwahl vorbelegen.
  if (!Array.isArray(raw)) {
    return Array.from({ length: DIRECT_SLOT_COUNT }, (_, index) => targets[index]?.id ?? null);
  }
  return Array.from({ length: DIRECT_SLOT_COUNT }, (_, index) =>
    ids.has(raw[index]) ? raw[index] : null);
}

function newTargetId() {
  if (globalThis.crypto?.randomUUID) return `ziel-${globalThis.crypto.randomUUID()}`;
  return `ziel-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export class ViewSwitcher {
  constructor({ viewport, loadTargets, loadSlots = async () => null, saveTargets,
    changed = () => {}, createId = newTargetId, wait = delay,
    syncViewEnabled = () => false }) {
    this.viewport = viewport;
    this.loadTargets = loadTargets;
    this.loadSlots = loadSlots;
    this.saveTargets = saveTargets;
    this.changed = changed;
    this.createId = createId;
    this.wait = wait;
    this.syncViewEnabled = syncViewEnabled;
    this.targets = [];
    this.slots = Array(DIRECT_SLOT_COUNT).fill(null);
    this.mode = "none";
    this.activeId = null;
    this.busy = false;
  }

  getState() {
    return {
      configured: this.targets.length > 0,
      targets: this.targets.map(({ id, name }) => ({ id, name })),
      slots: [...this.slots],
      mode: this.mode,
      activeId: this.activeId,
      busy: this.busy,
    };
  }

  async refreshTargets() {
    if (this.busy) return this.getState();
    const [targets, slots] = await Promise.all([this.loadTargets(), this.loadSlots()]);
    this.targets = normalizeTargets(targets);
    this.slots = normalizeSlots(slots, this.targets);
    if (!this.targets.some((item) => item.id === this.activeId)) {
      this.activeId = null;
      this.mode = "none";
    }
    this.changed(this.getState());
    return this.getState();
  }

  async currentView() {
    const [position, scale] = await Promise.all([
      this.viewport.getPosition(),
      this.viewport.getScale(),
    ]);
    const view = { position, scale };
    if (!validView(view)) throw new Error("Die aktuelle Kameraansicht ist ungültig.");
    return copyView(view);
  }

  async withLock(operation) {
    if (this.busy) return false;
    this.busy = true;
    this.changed(this.getState());
    try {
      return await operation();
    } finally {
      this.busy = false;
      this.changed(this.getState());
    }
  }

  findTarget(id) {
    const item = this.targets.find((candidate) => candidate.id === id);
    if (!item) throw new Error("Diese gespeicherte Ansicht existiert nicht mehr.");
    return item;
  }

  validateName(name, excludeId = null) {
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (!trimmed) throw new Error("Bitte einen Namen für die Ansicht eingeben.");
    if (trimmed.length > 45) throw new Error("Der Name darf höchstens 45 Zeichen enthalten.");
    if (this.targets.some((item) =>
      item.id !== excludeId && item.name.toLocaleLowerCase("de") === trimmed.toLocaleLowerCase("de"))) {
      throw new Error("Eine Ansicht mit diesem Namen ist bereits vorhanden.");
    }
    return trimmed;
  }

  async createTarget(name) {
    return this.withLock(async () => {
      const trimmed = this.validateName(name);
      const target = { id: this.createId(), name: trimmed, view: await this.currentView() };
      if (this.targets.some((item) => item.id === target.id)) throw new Error("Doppelte Ansichtskennung.");
      const next = [...this.targets, target];
      const nextSlots = [...this.slots];
      const freeSlot = nextSlots.indexOf(null);
      if (freeSlot !== -1) nextSlots[freeSlot] = target.id;
      await this.saveTargets(next, nextSlots);
      this.targets = next;
      this.slots = nextSlots;
      return target.id;
    });
  }

  async renameTarget(id, name) {
    return this.withLock(async () => {
      this.findTarget(id);
      const trimmed = this.validateName(name, id);
      const next = this.targets.map((item) => item.id === id ? { ...item, name: trimmed } : item);
      await this.saveTargets(next, this.slots);
      this.targets = next;
      return true;
    });
  }

  async updateTarget(id) {
    return this.withLock(async () => {
      this.findTarget(id);
      const view = await this.currentView();
      const next = this.targets.map((item) => item.id === id ? { ...item, view } : item);
      await this.saveTargets(next, this.slots);
      this.targets = next;
      return true;
    });
  }

  async deleteTarget(id) {
    return this.withLock(async () => {
      this.findTarget(id);
      const next = this.targets.filter((item) => item.id !== id);
      const nextSlots = this.slots.map((value) => value === id ? null : value);
      await this.saveTargets(next, nextSlots);
      this.targets = next;
      this.slots = nextSlots;
      if (this.activeId === id) {
        this.activeId = null;
        this.mode = "none";
      }
      return true;
    });
  }

  async assignSlot(slotNumber, targetId) {
    return this.withLock(async () => {
      if (!Number.isInteger(slotNumber) || slotNumber < 1 || slotNumber > DIRECT_SLOT_COUNT) {
        throw new Error("Der Ansichtsplatz muss zwischen 1 und 8 liegen.");
      }
      const id = targetId === null ? null : this.findTarget(targetId).id;
      const nextSlots = [...this.slots];
      nextSlots[slotNumber - 1] = id;
      await this.saveTargets(this.targets, nextSlots);
      this.slots = nextSlots;
      return true;
    });
  }

  async goToSlot(slotNumber) {
    if (!Number.isInteger(slotNumber) || slotNumber < 1 || slotNumber > DIRECT_SLOT_COUNT) {
      throw new Error("Ungültiger Ansichtsplatz.");
    }
    const targetId = this.slots[slotNumber - 1];
    if (!targetId) return false; // Ein freier Platz tut absichtlich nichts.
    return this.goTo(targetId);
  }

  async goTo(id) {
    if (this.busy) return false;
    const target = this.findTarget(id);
    return this.withLock(async () => {
      // Immer an die ausdruecklich gespeicherte Position, auch wenn
      // dieselbe Ansicht nach manuellem Zoomen erneut ausgewaehlt wird.
      // No animated camera movement through neighbouring images. Applying
      // scale before position, followed by verification, avoids the occasional
      // one-click vertical shift that a parallel Promise.all produced.
      const view = copyView(target.view);
      await applyFixedView(this.viewport, view, this.wait);
      // GM read-back alone cannot verify what the player screen displays.
      // With live Sync View, repeat only the final position: this is the
      // equivalent of the second pad press that empirically fixes the client.
      if (this.syncViewEnabled()) {
        await reinforceSyncedPosition(this.viewport, view, this.wait);
      }
      this.mode = "target";
      this.activeId = id;
      return true;
    });
  }

  async restoreTarget(id) {
    return this.goTo(id);
  }

  async toggle() {
    // Das bisherige J-Kuerzel geht jetzt zur naechsten festen Ansicht.
    return this.cycle(1);
  }

  async cycle(direction) {
    if (this.busy) return false;
    if (!this.targets.length) throw new Error("Bitte zuerst eine Zielansicht speichern.");
    const index = this.targets.findIndex((item) => item.id === this.activeId);
    const nextIndex = index < 0
      ? (direction > 0 ? 0 : this.targets.length - 1)
      : (index + (direction > 0 ? 1 : -1) + this.targets.length) % this.targets.length;
    return this.goTo(this.targets[nextIndex].id);
  }

  resetOnSceneChange() {
    this.targets = [];
    this.slots = Array(DIRECT_SLOT_COUNT).fill(null);
    this.mode = "none";
    this.activeId = null;
    this.busy = false;
    this.changed(this.getState());
  }
}
