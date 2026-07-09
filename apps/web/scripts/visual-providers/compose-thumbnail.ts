/**
 * Composites accurate title/category/one-liner text onto an Imagen-generated
 * product showcase image.
 *
 * Imagen is prompted (see types.ts buildShowcasePrompt) to leave ALL text out
 * of the illustration, because it reliably mangles rendered text (mojibake /
 * garbled glyphs — a known Imagen weakness, see commit 786c2018). Instead, the
 * real title/category/one-liner are laid down here as an SVG overlay and
 * rasterized onto the image with sharp, so the text is always correct.
 *
 * Server-side rasterization of Japanese text requires a CJK font to be present
 * in the runtime image (see apps/web/Dockerfile: fonts-noto-cjk) — without it
 * this renders as empty/tofu glyphs.
 */
import sharp from "sharp";

const escapeXml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const clip = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;

export type ThumbnailTextFields = {
  title: string;
  oneLiner: string;
  category: string;
};

/** Hackbase.ai masthead accent (memory: prodia-ui-final-direction, H案 dark/cyan). */
const ACCENT = "#22d3ee";

const buildOverlaySvg = (width: number, height: number, fields: ThumbnailTextFields): string => {
  const bandHeight = Math.round(height * 0.26);
  const bandY = height - bandHeight;
  const padX = Math.round(width * 0.045);
  const categorySize = Math.round(height * 0.03);
  const titleSize = Math.round(height * 0.065);
  const oneLinerSize = Math.round(height * 0.026);

  const category = escapeXml(clip(fields.category.toUpperCase(), 28));
  const title = escapeXml(clip(fields.title, 34));
  const oneLiner = escapeXml(clip(fields.oneLiner, 84));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bandFade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#020617" stop-opacity="0"/>
      <stop offset="55%" stop-color="#020617" stop-opacity="0.82"/>
      <stop offset="100%" stop-color="#020617" stop-opacity="0.94"/>
    </linearGradient>
  </defs>
  <rect x="0" y="${bandY}" width="${width}" height="${bandHeight}" fill="url(#bandFade)"/>
  <rect x="${padX}" y="${bandY + Math.round(bandHeight * 0.22)}" width="${Math.round(width * 0.05)}" height="6" rx="3" fill="${ACCENT}"/>
  <text x="${padX}" y="${bandY + Math.round(bandHeight * 0.42)}" font-family="Inter, 'Noto Sans JP', Arial, sans-serif" font-size="${categorySize}" font-weight="800" letter-spacing="2" fill="${ACCENT}">${category}</text>
  <text x="${padX}" y="${bandY + Math.round(bandHeight * 0.68)}" font-family="Inter, 'Noto Sans JP', Arial, sans-serif" font-size="${titleSize}" font-weight="900" fill="#f8fafc">${title}</text>
  <text x="${padX}" y="${height - Math.round(height * 0.045)}" font-family="Inter, 'Noto Sans JP', Arial, sans-serif" font-size="${oneLinerSize}" font-weight="500" fill="#cbd5e1">${oneLiner}</text>
</svg>`;
};

/**
 * Lays the real title/category/one-liner over a text-free Imagen illustration.
 * Reads the source image's actual dimensions so the overlay always matches.
 */
export const composeThumbnailText = async (
  imageBuffer: Buffer,
  fields: ThumbnailTextFields,
): Promise<Buffer> => {
  const base = sharp(imageBuffer);
  const metadata = await base.metadata();
  const width = metadata.width ?? 1280;
  const height = metadata.height ?? 720;
  const overlaySvg = buildOverlaySvg(width, height, fields);
  return base
    .composite([{ input: Buffer.from(overlaySvg), top: 0, left: 0 }])
    .png()
    .toBuffer();
};
