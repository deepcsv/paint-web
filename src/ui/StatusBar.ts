export class StatusBar {
  readonly el: HTMLElement;
  private pos: HTMLElement;
  private info: HTMLElement;
  private layerInfo: HTMLElement;

  constructor(mount: HTMLElement) {
    this.el = mount;
    this.pos = document.createElement("span");
    this.info = document.createElement("span");
    this.layerInfo = document.createElement("span");
    this.el.appendChild(this.pos);
    this.el.appendChild(this.layerInfo);
    this.el.appendChild(this.info);
    this.setPos(null, null);
    this.setCanvasInfo(1280, 720);
    this.setActiveLayer(null);
  }

  setPos(x: number | null, y: number | null): void {
    this.pos.textContent = x === null ? "x: -  y: -" : `x: ${x}  y: ${y}`;
  }

  setCanvasInfo(width: number, height: number): void {
    this.info.textContent = `${width} × ${height}`;
  }

  setActiveLayer(layerId: string | null, name?: string): void {
    if (layerId === null) {
      this.layerInfo.textContent = "no active layer";
    } else {
      const short = layerId.length > 12 ? layerId.slice(0, 12) : layerId;
      this.layerInfo.textContent = `active: ${name ?? short}`;
    }
  }
}
