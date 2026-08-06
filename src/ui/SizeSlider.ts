export class SizeSlider {
  readonly el: HTMLElement;
  private current = 8;
  private listeners: ((size: number) => void)[] = [];

  constructor(mount: HTMLElement, initial = 8) {
    this.el = mount;
    this.current = initial;
    this.render();
  }

  private render(): void {
    this.el.innerHTML = "";

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "1";
    slider.max = "100";
    slider.value = String(this.current);

    const value = document.createElement("div");
    value.className = "value";
    const label = document.createElement("span");
    label.textContent = `${this.current} px`;
    const preview = document.createElement("span");
    preview.textContent = "●".repeat(Math.max(1, Math.min(5, Math.round(this.current / 8))));
    value.appendChild(label);
    value.appendChild(preview);

    slider.addEventListener("input", () => {
      this.current = parseInt(slider.value, 10);
      label.textContent = `${this.current} px`;
      preview.textContent = "●".repeat(Math.max(1, Math.min(5, Math.round(this.current / 8))));
      for (const l of this.listeners) l(this.current);
    });

    this.el.appendChild(slider);
    this.el.appendChild(value);
  }

  getSize(): number {
    return this.current;
  }

  setSize(size: number): void {
    this.current = size;
    const slider = this.el.querySelector('input[type="range"]') as HTMLInputElement;
    if (slider) slider.value = String(size);
    const label = this.el.querySelector(".value span") as HTMLElement;
    if (label) label.textContent = `${size} px`;
  }

  onChange(cb: (size: number) => void): void {
    this.listeners.push(cb);
  }
}
