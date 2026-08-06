const PALETTE = [
  "#000000", "#444444", "#888888", "#cccccc", "#ffffff", "#ffffff00",
  "#ff0000", "#ff8000", "#ffff00", "#80ff00", "#00ff00", "#00ff80",
  "#00ffff", "#0080ff", "#0000ff", "#8000ff", "#ff00ff", "#ff0080",
  "#8b4513", "#a0522d", "#cd853f", "#daa520", "#b8860b", "#8b0000",
];

export class ColorPicker {
  readonly el: HTMLElement;
  private current = "#000000";
  private listeners: ((color: string) => void)[] = [];

  constructor(mount: HTMLElement) {
    this.el = mount;
    this.render();
  }

  private render(): void {
    this.el.innerHTML = "";

    const current = document.createElement("div");
    current.className = "current";

    const swatch = document.createElement("div");
    swatch.className = "swatch";
    swatch.style.background = this.current;

    const input = document.createElement("input");
    input.type = "color";
    input.value = this.current;
    input.addEventListener("input", () => this.setColor(input.value));

    current.appendChild(swatch);
    current.appendChild(input);
    this.el.appendChild(current);

    const palette = document.createElement("div");
    palette.className = "palette";
    for (const c of PALETTE) {
      const btn = document.createElement("button");
      btn.style.background = c;
      btn.title = c;
      btn.addEventListener("click", () => this.setColor(c));
      palette.appendChild(btn);
    }
    this.el.appendChild(palette);
  }

  setColor(color: string): void {
    this.current = color;
    const swatch = this.el.querySelector(".swatch") as HTMLElement;
    if (swatch) swatch.style.background = color;
    const input = this.el.querySelector('input[type="color"]') as HTMLInputElement;
    if (input && color.length === 7) input.value = color;
    for (const l of this.listeners) l(color);
  }

  getColor(): string {
    return this.current;
  }

  onChange(cb: (color: string) => void): void {
    this.listeners.push(cb);
  }
}
