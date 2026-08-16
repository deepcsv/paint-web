// Watercolor pigment library — Kubelka-Munk color science.
// Three-field watercolor model after Curtis et al. 1997: each pigment is
// defined by how a unit glaze looks over white and over black, from which
// per-channel absorption K and scattering S are derived.
// gran: granulation (settles into paper valleys), stain: staining strength,
// dens: particle density (heavy particles settle under flow, light ones bloom).

const srgb2lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const lin2srgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const hex2lin = (h: string): [number, number, number] =>
  [1, 3, 5].map(i => srgb2lin(parseInt(h.slice(i, i + 2), 16) / 255)) as [number, number, number];

const acoth = (x: number) => 0.5 * Math.log((x + 1) / (x - 1));

function deriveKS(Rw: number, Rb: number): [number, number] {
  Rw = Math.min(Math.max(Rw, 0.001), 0.998);
  Rb = Math.min(Math.max(Rb, 0.0005), Rw * 0.98);
  const a = 0.5 * (Rw + (Rb - Rw + 1) / Rb);
  const b = Math.sqrt(Math.max(a * a - 1, 1e-12));
  const arg = Math.max((b * b - (a - Rw) * (a - 1)) / (b * (1 - Rw)), 1.0000001);
  const S = (1 / b) * acoth(arg);
  const K = S * (a - 1);
  return [K, S];
}

export function kmReflect(K: number, S: number, Rg: number): number {
  if (S < 1e-6) return Rg;
  const a = 1 + K / S;
  const b = Math.sqrt(Math.max(a * a - 1, 1e-9));
  const e = Math.exp(-2 * Math.max(b * S, 1e-4));
  const cth = (1 + e) / (1 - e);
  return (1 - Rg * (a - b * cth)) / (a - Rg + b * cth);
}

/** Saturating dilution: density -> optical thickness. A wash approaches
 *  masstone but never reaches black; the gamma opens up pale washes. */
export function dilute(d: number): number {
  const g = Math.pow(Math.max(d, 0), 1.35);
  return 2.2 * g / (g + 3.0);
}

export interface Pigment {
  id: number;
  name: string;
  gran: number;
  stain: number;
  dens: number;
  family: string;
  K: [number, number, number];
  S: [number, number, number];
}

// name, over-white, over-black, gran, stain, dens, family
const RAW: [string, string, string, number, number, number, string][] = [
  ["French Ultramarine", "#3b55c4", "#0a102a", 0.85, 0.3, 0.9, "blue"],
  ["Cerulean Blue", "#4f9ad2", "#173349", 0.9, 0.2, 0.95, "blue"],
  ["Phthalo Turquoise", "#12716e", "#03201f", 0.1, 0.9, 0.3, "blue"],
  ["Cobalt Teal", "#3fb8ab", "#0b2f2b", 0.8, 0.2, 0.85, "blue"],
  ["Phthalo Green", "#0e8a6b", "#03231b", 0.05, 0.95, 0.25, "green"],
  ["Sap Green", "#6d8e39", "#1b240f", 0.25, 0.6, 0.4, "green"],
  ["Terre Verte", "#7d9179", "#2c352a", 0.85, 0.1, 0.8, "green"],
  ["Hansa Yellow", "#f4e04b", "#4a4410", 0.05, 0.5, 0.3, "yellow"],
  ["Yellow Ochre", "#d9a751", "#57431e", 0.55, 0.3, 0.7, "yellow"],
  ["Quinacridone Gold", "#c8892b", "#3f2a08", 0.1, 0.8, 0.3, "yellow"],
  ["Pyrrol Orange", "#e8702e", "#431c08", 0.1, 0.7, 0.35, "red"],
  ["Cadmium Red", "#d63a2e", "#57140f", 0.45, 0.4, 0.8, "red"],
  ["Quinacridone Rose", "#e04b8a", "#400f26", 0.05, 0.8, 0.25, "red"],
  ["Alizarin Crimson", "#b92b46", "#33060e", 0.1, 0.85, 0.3, "red"],
  ["Burnt Sienna", "#b65a33", "#33130a", 0.6, 0.4, 0.7, "earth"],
  ["Payne's Gray", "#46536a", "#0a0d14", 0.35, 0.6, 0.55, "neutral"],
  ["Ivory Black", "#3a3a38", "#060605", 0.45, 0.5, 0.7, "neutral"],
];

export const PIGMENTS: Pigment[] = RAW.map(([name, w, b, gran, stain, dens, family], id) => {
  const lw = hex2lin(w), lb = hex2lin(b);
  // staining low-density pigments are near-pure absorbers: pull the
  // over-black target toward black so their scattering collapses and
  // glazes glow instead of turning chalky.
  const transp = Math.min(Math.max(stain * 0.55 + (1 - dens) * 0.45, 0), 1);
  const opaq = 1 - 0.8 * Math.pow(transp, 1.25);
  const K = [0, 0, 0] as [number, number, number];
  const S = [0, 0, 0] as [number, number, number];
  for (let ch = 0; ch < 3; ch++) {
    const [kc, sc] = deriveKS(lw[ch], lb[ch] * opaq);
    K[ch] = kc; S[ch] = sc;
  }
  return { id, name, gran, stain, dens, family, K, S };
});

export function pigmentByName(name: string): Pigment | undefined {
  const lower = name.toLowerCase();
  return PIGMENTS.find(p => p.name.toLowerCase() === lower);
}

/**
 * Pack a stroke's pigment mixture into the 8 slot vectors the sim uses.
 * Slots are assigned in mixture order; concentration follows the brush
 * wetness curve (more water = weaker tint) until the puddle saturates,
 * after which amounts become ratios.
 */
export function buildSlotLoads(
  mix: { name: string; amount: number }[],
  water: number,
): {
  loads: Float32Array; // 8
  gran: Float32Array;  // 8
  stain: Float32Array; // 8
  dens: Float32Array;  // 8
  K: Float32Array;     // 24 (8 × rgb)
  S: Float32Array;     // 24
} {
  const loads = new Float32Array(8);
  const gran = new Float32Array(8);
  const stain = new Float32Array(8).fill(1);
  const dens = new Float32Array(8).fill(0.5);
  const K = new Float32Array(24);
  const S = new Float32Array(24);
  let total = 0;
  for (const m of mix) total += m.amount;
  const conc = 0.25 + 1.75 * Math.pow(1 - water, 1.7);
  const scale = total > 1 ? 1 / total : 1;
  mix.slice(0, 8).forEach((m, i) => {
    const pig = pigmentByName(m.name);
    if (!pig) return;
    loads[i] = m.amount * scale * 0.16 * conc;
    gran[i] = pig.gran;
    stain[i] = pig.stain;
    dens[i] = pig.dens;
    for (let c = 0; c < 3; c++) {
      K[i * 3 + c] = pig.K[c];
      S[i * 3 + c] = pig.S[c];
    }
  });
  return { loads, gran, stain, dens, K, S };
}
