/**
 * HistoryStack — per-layer undo/redo using full ImageData backups.
 *
 * Memory math: a 1280×720 RGBA ImageData = ~3.7 MB. With 30 steps × 1 layer
 * = ~111 MB. Acceptable for desktop. v2 will use dirty-region diff.
 */

const MAX_DEPTH = 30;

export class HistoryStack {
  private undoStack = new Map<string, ImageData[]>();
  private redoStack = new Map<string, ImageData[]>();

  /**
   * Call BEFORE mutating a layer. Captures the layer's current pixels so
   * undo can restore them.
   */
  pushBeforeChange(layerId: string, current: ImageData): void {
    const stack = this.undoStack.get(layerId) ?? [];
    const snapshot = new ImageData(
      new Uint8ClampedArray(current.data),
      current.width,
      current.height,
    );
    stack.push(snapshot);
    if (stack.length > MAX_DEPTH) stack.shift();
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
