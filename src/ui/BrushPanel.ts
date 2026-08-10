import { PACKAGES } from "../brush/BrushPresets.js";
import type { BrushPreset } from "../brush/BrushTypes.js";

/**
 * BrushPanel — UI for selecting from 94 reverse-engineered brush presets.
 *
 * Shows brushes grouped by package (常规画笔, 艺术画笔, etc.).
 * Each brush shows its name and a small preview dot.
 * Selecting a brush updates the active preset.
 */
export class BrushPanel {
  readonly el: HTMLElement;
  private current: BrushPreset | null = null;
  private listeners: ((preset: BrushPreset) => void)[] = [];

  constructor(mount: HTMLElement) {
    this.el = mount;
    this.render();
    const pencil = PACKAGES.flatMap((pkg) => pkg.brushes).find((brush) => brush.name === "铅笔");
    if (pencil) this.setBrush(pencil);
  }

  private render(): void {
    this.el.innerHTML = "";

    // Package selector + brush grid
    for (const pkg of PACKAGES) {
      const section = document.createElement("div");
      section.className = "brush-pkg-section";

      const header = document.createElement("button");
      header.type = "button";
      header.className = "brush-pkg-header";
      header.textContent = `${pkg.name} (${pkg.brushes.length})`;
      header.setAttribute("aria-expanded", "true");
      header.addEventListener("click", () => {
        section.classList.toggle("collapsed");
        header.setAttribute("aria-expanded", String(!section.classList.contains("collapsed")));
      });
      section.appendChild(header);

      const grid = document.createElement("div");
      grid.className = "brush-grid";

      for (const brush of pkg.brushes) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "brush-item";
        item.setAttribute("aria-label", brush.name);
        item.title = `${brush.name}\nw=${brush.width} sp=${brush.spacing.toFixed(2)} hd=${brush.hardness.toFixed(2)} fl=${brush.brushFlow.toFixed(2)}`;

        // Preview dot — reflects brush hardness/roundness
        const dot = document.createElement("div");
        dot.className = "brush-dot";
        const size = Math.min(28, Math.max(6, brush.width / 6));
        dot.style.width = `${size}px`;
        dot.style.height = `${size * brush.roundness}px`;
        if (brush.hardness < 0.5) {
          dot.style.boxShadow = `0 0 ${size / 3}px currentColor`;
        }
        if (brush.eraser) {
          dot.style.background = "transparent";
          dot.style.border = "1.5px dashed #888";
        }
        item.appendChild(dot);

        const name = document.createElement("span");
        name.className = "brush-name";
        name.textContent = brush.name;
        item.appendChild(name);

        item.addEventListener("click", () => {
          this.setBrush(brush);
        });

        grid.appendChild(item);
      }

      section.appendChild(grid);
      this.el.appendChild(section);
    }
  }

  setBrush(preset: BrushPreset): void {
    this.current = preset;
    // Update active class
    for (const item of Array.from(this.el.querySelectorAll(".brush-item"))) {
      item.classList.toggle("active", (item.querySelector(".brush-name") as HTMLElement)?.textContent === preset.name);
    }
    for (const l of this.listeners) l(preset);
  }

  getBrush(): BrushPreset | null {
    return this.current;
  }

  onChange(cb: (preset: BrushPreset) => void): void {
    this.listeners.push(cb);
    if (this.current) cb(this.current);
  }
}
