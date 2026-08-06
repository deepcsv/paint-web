import type { Tool } from "../input/PointerHandler.js";

interface ToolDef {
  id: Tool;
  label: string;
  icon: string;
}

const TOOLS: ToolDef[] = [
  { id: "brush", label: "Brush", icon: "✎" },
  { id: "eraser", label: "Eraser", icon: "⌫" },
  { id: "line", label: "Line", icon: "╲" },
  { id: "rect", label: "Rect", icon: "▭" },
  { id: "circle", label: "Circle", icon: "○" },
  { id: "ellipse", label: "Ellipse", icon: "◯" },
  { id: "fill", label: "Fill", icon: "🪣" },
  { id: "text", label: "Text", icon: "T" },
  { id: "setPixel", label: "Pixel", icon: "▪" },
];

export class Toolbar {
  readonly el: HTMLElement;
  private current: Tool = "brush";
  private listeners: ((tool: Tool) => void)[] = [];

  constructor(mount: HTMLElement) {
    this.el = mount;
    this.render();
  }

  private render(): void {
    this.el.innerHTML = "";
    for (const tool of TOOLS) {
      const btn = document.createElement("button");
      btn.title = tool.label;
      btn.textContent = tool.icon;
      btn.dataset.tool = tool.id;
      if (tool.id === this.current) btn.classList.add("active");
      btn.addEventListener("click", () => this.setTool(tool.id));
      this.el.appendChild(btn);
    }
  }

  setTool(tool: Tool): void {
    if (this.current === tool) return;
    this.current = tool;
    for (const btn of Array.from(this.el.children) as HTMLButtonElement[]) {
      btn.classList.toggle("active", btn.dataset.tool === tool);
    }
    for (const l of this.listeners) l(tool);
  }

  getTool(): Tool {
    return this.current;
  }

  onChange(cb: (tool: Tool) => void): void {
    this.listeners.push(cb);
  }
}
