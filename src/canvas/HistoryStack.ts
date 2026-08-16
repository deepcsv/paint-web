/**
 * HistoryStack — per-layer undo/redo using full ImageData backups.
 *
 * Memory math: a 1280×720 RGBA ImageData = ~3.7 MB. With 30 steps × 1 layer
 * = ~111 MB. Acceptable for desktop. v2 will use dirty-region diff.
 *
 * Chromium caps total canvas backing memory; once exceeded it silently PURGES
 * older 2D canvases — layers come back listed-but-empty. Multi-layer agent
 * documents (13 layers × 7.2 MB each at 1200×1500) cross that line long
 * before 30 snapshots per layer, so the depth is budget-derived: never keep
 * more snapshots per layer than ~64 MB worth, and never more than the whole
 * document can afford across layers.
 */

const MAX_DEPTH = 30;
const SNAPSHOT_BUDGET_BYTES = 64 * 1024 * 1024;
const DOCUMENT_BUDGET_BYTES = 256 * 1024 * 1024;

function bytesPerSnapshot(image: ImageData): number {
  return image.width * image.height * 4;
}

function depthCap(image: ImageData, layerCount: number): number {
  const perLayer = Math.max(1, Math.floor(SNAPSHOT_BUDGET_BYTES / bytesPerSnapshot(image)));
  const perDoc = Math.max(1, Math.floor(DOCUMENT_BUDGET_BYTES / (bytesPerSnapshot(image) * Math.max(1, layerCount))));
  return Math.max(1, Math.min(MAX_DEPTH, perLayer, perDoc));
}

export class HistoryStack {
  private undoStack = new Map<string, ImageData[]>();
  private redoStack = new Map<string, ImageData[]>();

  /**
   * Call BEFORE mutating a layer. Captures the layer's current pixels so
   * undo can restore them.
   */
  pushBeforeChange(layerId: string, current: ImageData): void {
    const stack = this.undoStack.get(layerId) ?? [];
    // Drop the oldest snapshots while the total retained bytes exceed the
    // document budget — a cleared canvas is far worse than a shorter undo.
    const cap = depthCap(current, Math.max(this.undoStack.size, 1));
    const capBytes = DOCUMENT_BUDGET_BYTES;
    let retained = 0;
    for (const arr of this.undoStack.values()) for (const img of arr) retained += bytesPerSnapshot(img);
    while ((stack.length >= cap || retained + bytesPerSnapshot(current) > capBytes) && stack.length > 0) {
      const dropped = stack.shift()!;
      retained -= bytesPerSnapshot(dropped);
    }
    const snapshot = new ImageData(
      new Uint8ClampedArray(current.data),
      current.width,
      current.height,
    );
    stack.push(snapshot);
    this.undoStack.set(layerId, stack);
    this.redoStack.set(layerId, []);
  }

  /** Undo: returns the previous state, or null if no history. */
  undo(layerId: string, current: ImageData): ImageData | null {
    const stack = this.undoStack.get(layerId);
    if (!stack || stack.length === 0) return null;
    const previous = stack.pop()!;
    const redoArr = this.redoStack.get(layerId) ?? [];
    redoArr.push(
      new ImageData(
        new Uint8ClampedArray(current.data),
        current.width,
        current.height,
      ),
    );
    this.redoStack.set(layerId, redoArr);
    return previous;
  }

  /** Redo: returns the next state, or null if no future. */
  redo(layerId: string, current: ImageData): ImageData | null {
    const redoArr = this.redoStack.get(layerId);
    if (!redoArr || redoArr.length === 0) return null;
    const next = redoArr.pop()!;
    const undoArr = this.undoStack.get(layerId) ?? [];
    undoArr.push(
      new ImageData(
        new Uint8ClampedArray(current.data),
        current.width,
        current.height,
      ),
    );
    if (undoArr.length > MAX_DEPTH) undoArr.shift();
    this.undoStack.set(layerId, undoArr);
    return next;
  }

  clear(layerId?: string): void {
    if (layerId) {
      this.undoStack.delete(layerId);
      this.redoStack.delete(layerId);
    } else {
      this.undoStack.clear();
      this.redoStack.clear();
    }
  }

  /** Drop all history for a layer when it's deleted. */
  dropLayer(layerId: string): void {
    this.undoStack.delete(layerId);
    this.redoStack.delete(layerId);
  }

  getLength(layerId: string): { undo: number; redo: number } {
    return {
      undo: this.undoStack.get(layerId)?.length ?? 0,
      redo: this.redoStack.get(layerId)?.length ?? 0,
    };
  }

  /** Aggregate across all layers. */
  getAggregateLength(): { undo: number; redo: number } {
    let undo = 0;
    let redo = 0;
    for (const arr of this.undoStack.values()) undo += arr.length;
    for (const arr of this.redoStack.values()) redo += arr.length;
    return { undo, redo };
  }
}
