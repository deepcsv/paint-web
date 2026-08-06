import type { Layer, LayerId } from "../../shared/protocol.js";

export class LayerPanel {
  readonly el: HTMLElement;
  private layers: Layer[] = [];
  private activeId: LayerId | null = null;
  private listeners: {
    onSelect?: (id: LayerId) => void;
    onToggleVisible?: (id: LayerId, visible: boolean) => void;
    onSetOpacity?: (id: LayerId, opacity: number) => void;
    onRename?: (id: LayerId, name: string) => void;
    onAdd?: () => void;
    onDelete?: (id: LayerId) => void;
  } = {};

  constructor(mount: HTMLElement) {
    this.el = mount;
    this.render();
  }

  setHandlers(handlers: LayerPanel["listeners"]): void {
    this.listeners = handlers;
  }

  update(layers: Layer[], activeId: LayerId | null): void {
    // Dirty check — skip DOM rebuild if nothing material changed.
    // This prevents flex reflow that causes canvas flicker on every stroke.
    if (this.activeId === activeId && this.layersSame(layers)) {
      return;
    }
    this.layers = layers;
    this.activeId = activeId;
    this.render();
  }

  private layersSame(other: Layer[]): boolean {
    if (this.layers.length !== other.length) return false;
    for (let i = 0; i < other.length; i++) {
      const a = this.layers[i];
      const b = other[i];
      if (!a) return false;
      if (
        a.id !== b.id ||
        a.name !== b.name ||
        a.visible !== b.visible ||
        a.opacity !== b.opacity ||
        a.blendMode !== b.blendMode
      ) {
        return false;
      }
    }
    return true;
  }

  private render(): void {
    this.el.innerHTML = "";

    // Layers displayed top-to-bottom (reverse of internal order)
    const ordered = [...this.layers].reverse();
    for (const layer of ordered) {
      const item = document.createElement("div");
      item.className = "layer-item";
      if (layer.id === this.activeId) item.classList.add("active");

      const visible = document.createElement("input");
      visible.type = "checkbox";
      visible.checked = layer.visible;
      visible.addEventListener("change", () => {
        this.listeners.onToggleVisible?.(layer.id, visible.checked);
      });

      const name = document.createElement("span");
      name.className = "name";
      name.textContent = layer.name;
      name.title = layer.id;
      name.addEventListener("dblclick", () => {
        const newName = prompt("Rename layer:", layer.name);
        if (newName && newName !== layer.name) {
          this.listeners.onRename?.(layer.id, newName);
        }
      });

      item.addEventListener("click", (e) => {
        if (e.target === visible) return;
        this.listeners.onSelect?.(layer.id);
      });

      const opacity = document.createElement("input");
      opacity.type = "range";
      opacity.min = "0";
      opacity.max = "1";
      opacity.step = "0.05";
      opacity.value = String(layer.opacity);
      opacity.addEventListener("input", () => {
        this.listeners.onSetOpacity?.(layer.id, parseFloat(opacity.value));
      });

      item.appendChild(visible);
      item.appendChild(name);
      item.appendChild(opacity);
      this.el.appendChild(item);
    }

    const addBtn = document.createElement("button");
    addBtn.className = "add-layer";
    addBtn.textContent = "+ New Layer";
    addBtn.addEventListener("click", () => this.listeners.onAdd?.());
    this.el.appendChild(addBtn);
  }
}
