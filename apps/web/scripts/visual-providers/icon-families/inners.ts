/**
 * Inner-mark catalog for product icons (DOC-105 icon direction).
 *
 * Each entry is one abstract mark drawn centered on a 512x512 canvas. `render`
 * receives the primary mark color and an accent color (a few marks are two-tone)
 * plus a context (the product initial, used by the lettermark).
 *
 * `complexity` drives the frameless guardrail: frameless / outline shapes may
 * only use `rich` marks (multi-element compositions), so a naked container never
 * ends up with a single lonely glyph. `simple` marks are reserved for framed
 * shapes. See ./select.ts for the allowed matrix.
 */

export type Complexity = "simple" | "rich";

export type InnerContext = { letter: string };

export type InnerRender = (mark: string, accent: string, ctx: InnerContext) => string;

export type Inner = {
  key: string;
  complexity: Complexity;
  render: InnerRender;
};

export const INNERS: Inner[] = [
  // --- simple: only ever used inside a frame ---------------------------------
  {
    key: "arrow",
    complexity: "simple",
    render: (mc) => `<path d="M256 168 L360 296 L292 296 L292 372 L220 372 L220 296 L152 296 Z" fill="${mc}"/>`,
  },
  {
    key: "chevron",
    complexity: "simple",
    render: (mc) =>
      `<path d="M198 152 L342 256 L198 360" fill="none" stroke="${mc}" stroke-width="48" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  {
    key: "gem",
    complexity: "simple",
    render: (mc, ac) =>
      `<path d="M256 138 L374 256 L256 374 L138 256 Z" fill="${mc}"/><path d="M198 256 H314 M256 198 V314" stroke="${ac}" stroke-width="24" stroke-linecap="round"/>`,
  },
  {
    key: "spark",
    complexity: "simple",
    render: (mc) =>
      `<path d="M256 116 C280 214 298 232 396 256 C298 280 280 298 256 396 C232 298 214 280 116 256 C214 232 232 214 256 116 Z" fill="${mc}"/>`,
  },
  {
    key: "bolt",
    complexity: "simple",
    render: (mc) => `<path d="M290 132 L156 288 L242 288 L222 380 L356 224 L270 224 Z" fill="${mc}"/>`,
  },
  {
    key: "letter",
    complexity: "simple",
    render: (mc, _ac, ctx) =>
      `<text x="256" y="356" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="300" font-weight="800" fill="${mc}">${ctx.letter}</text>`,
  },

  // --- rich: multi-element; allowed frameless/outline ------------------------
  {
    key: "wave",
    complexity: "rich",
    render: (mc, ac) => {
      const ys = [236, 180, 120, 204, 150, 96, 176, 214];
      let s = "";
      for (let i = 0; i < 8; i += 1) {
        s += `<rect x="${132 + i * 32}" y="${ys[i]}" width="20" height="${388 - ys[i]}" rx="10" fill="${i === 5 ? ac : mc}"/>`;
      }
      return `${s}<rect x="126" y="392" width="260" height="10" rx="5" fill="${mc}" opacity="0.45"/>`;
    },
  },
  {
    key: "chart",
    complexity: "rich",
    render: (mc, ac) => {
      const tops = [300, 248, 196, 140];
      let s = "";
      for (let i = 0; i < 4; i += 1) {
        s += `<rect x="${150 + i * 66}" y="${tops[i]}" width="46" height="${372 - tops[i]}" rx="10" fill="${mc}"/>`;
      }
      return `${s}<polyline points="173,286 239,234 305,182 371,126" fill="none" stroke="${ac}" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/><circle cx="371" cy="126" r="22" fill="${ac}"/>`;
    },
  },
  {
    key: "radar",
    complexity: "rich",
    render: (mc, ac) =>
      `<circle cx="256" cy="256" r="158" fill="none" stroke="${mc}" stroke-width="14" opacity="0.5"/><circle cx="256" cy="256" r="106" fill="none" stroke="${mc}" stroke-width="14" opacity="0.7"/><path d="M100 256 H412 M256 100 V412" stroke="${mc}" stroke-width="10" opacity="0.4"/><path d="M256 256 L360 168" stroke="${ac}" stroke-width="16" stroke-linecap="round"/><circle cx="256" cy="256" r="34" fill="${ac}"/>`,
  },
  {
    key: "network",
    complexity: "rich",
    render: (mc, ac) =>
      `<path d="M180 194 L332 200 M180 194 L214 336 M332 200 L326 330 M214 336 L326 330 M180 194 L326 330" stroke="${mc}" stroke-width="16" stroke-linecap="round" opacity="0.9"/><circle cx="180" cy="194" r="36" fill="${mc}"/><circle cx="332" cy="200" r="36" fill="${ac}"/><circle cx="214" cy="336" r="36" fill="${ac}"/><circle cx="326" cy="330" r="36" fill="${mc}"/>`,
  },
  {
    key: "orbit",
    complexity: "rich",
    render: (mc, ac) =>
      `<ellipse cx="256" cy="256" rx="152" ry="66" fill="none" stroke="${mc}" stroke-width="16" transform="rotate(-26 256 256)"/><ellipse cx="256" cy="256" rx="152" ry="66" fill="none" stroke="${ac}" stroke-width="16" transform="rotate(28 256 256)"/><circle cx="256" cy="256" r="40" fill="${mc}"/><circle cx="378" cy="196" r="22" fill="${ac}"/><circle cx="140" cy="312" r="18" fill="${mc}"/>`,
  },
  {
    key: "matrix",
    complexity: "rich",
    render: (mc, ac) => {
      let s = "";
      for (let r = 0; r < 4; r += 1) {
        for (let c = 0; c < 4; c += 1) {
          const hi = r === c;
          s += `<circle cx="${164 + c * 61}" cy="${164 + r * 61}" r="${hi ? 22 : 16}" fill="${hi ? ac : mc}" opacity="${hi ? 1 : 0.85}"/>`;
        }
      }
      return s;
    },
  },
  {
    key: "isostack",
    complexity: "rich",
    render: (mc, ac) =>
      `<path d="M256 138 L372 200 L256 262 L140 200 Z" fill="${mc}"/><path d="M140 244 L256 306 L372 244 L372 276 L256 338 L140 276 Z" fill="${ac}"/><path d="M140 316 L256 378 L372 316 L372 344 L256 406 L140 344 Z" fill="${mc}" opacity="0.7"/>`,
  },
  {
    key: "burst",
    complexity: "rich",
    render: (mc, ac) => {
      let s = "";
      for (let i = 0; i < 12; i += 1) {
        const angle = (i * 30 * Math.PI) / 180;
        const r1 = 58;
        const r2 = i % 3 === 0 ? 170 : 132;
        const x1 = Math.round(256 + r1 * Math.cos(angle));
        const y1 = Math.round(256 + r1 * Math.sin(angle));
        const x2 = Math.round(256 + r2 * Math.cos(angle));
        const y2 = Math.round(256 + r2 * Math.sin(angle));
        s += `<path d="M${x1} ${y1} L${x2} ${y2}" stroke="${i % 3 === 0 ? ac : mc}" stroke-width="16" stroke-linecap="round"/>`;
      }
      return `${s}<circle cx="256" cy="256" r="30" fill="${ac}"/>`;
    },
  },
  {
    key: "donut",
    complexity: "rich",
    render: (mc, ac) =>
      `<circle cx="256" cy="256" r="128" fill="none" stroke="${mc}" stroke-width="54"/><path d="M256 128 A128 128 0 0 1 384 256" fill="none" stroke="${ac}" stroke-width="54"/><circle cx="256" cy="256" r="30" fill="${ac}"/>`,
  },
  {
    key: "globe",
    complexity: "rich",
    render: (mc, ac) =>
      `<circle cx="256" cy="256" r="120" fill="none" stroke="${mc}" stroke-width="24"/><ellipse cx="256" cy="256" rx="52" ry="120" fill="none" stroke="${mc}" stroke-width="18"/><path d="M146 220 H366 M146 292 H366" stroke="${mc}" stroke-width="18"/><circle cx="256" cy="256" r="16" fill="${ac}"/>`,
  },
  {
    key: "chat",
    complexity: "rich",
    render: (mc, ac) =>
      `<rect x="140" y="150" width="232" height="168" rx="40" fill="${mc}"/><path d="M198 300 L198 372 L268 314 Z" fill="${mc}"/><circle cx="210" cy="234" r="16" fill="${ac}"/><circle cx="256" cy="234" r="16" fill="${ac}"/><circle cx="302" cy="234" r="16" fill="${ac}"/>`,
  },
  {
    key: "face",
    complexity: "rich",
    render: (mc, ac) =>
      `<circle cx="214" cy="248" r="30" fill="${mc}"/><circle cx="298" cy="248" r="30" fill="${mc}"/><circle cx="214" cy="248" r="12" fill="${ac}"/><circle cx="298" cy="248" r="12" fill="${ac}"/><path d="M210 316 Q256 352 302 316" stroke="${mc}" stroke-width="20" fill="none" stroke-linecap="round"/>`,
  },
];
