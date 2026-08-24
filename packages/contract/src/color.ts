import Color from "colorjs.io";

import type {
  AnchorPosition,
  AuthoredColorValue,
  OklchColorValue,
  RampGeneratorSettings,
  RampPosition,
  RampStop,
} from "./types";
import { ANCHOR_POSITIONS } from "./types";

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface Oklch {
  l: number;
  c: number;
  h: number;
  a: number;
}

interface Hsl {
  h: number;
  s: number;
  l: number;
}

export const RAMP_LIGHTNESS_BY_POSITION: Readonly<Record<AnchorPosition, number>> = {
  "000": 1,
  "050": 0.97,
  "100": 0.93,
  "200": 0.86,
  "300": 0.78,
  "400": 0.7,
  "500": 0.62,
  "600": 0.54,
  "700": 0.46,
  "800": 0.38,
  "900": 0.29,
  "950": 0.2,
  "1000": 0,
};

export const OKLCH_JND = 0.02;
const NEUTRAL_CHROMA_THRESHOLD = 0.0005;

function normalizeHue(value: number): number {
  return ((value % 360) + 360) % 360;
}

const HEX_COLOR = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i;

export function parseHexColor(input: string): Rgba | null {
  const match = HEX_COLOR.exec(input);
  if (!match?.[1]) return null;

  const rgb = match[1];
  return {
    r: Number.parseInt(rgb.slice(0, 2), 16) / 255,
    g: Number.parseInt(rgb.slice(2, 4), 16) / 255,
    b: Number.parseInt(rgb.slice(4, 6), 16) / 255,
    a: match[2] ? Number.parseInt(match[2], 16) / 255 : 1,
  };
}

function channelToHex(value: number): string {
  return Math.round(Math.max(0, Math.min(1, value)) * 255)
    .toString(16)
    .padStart(2, "0");
}

export function rgbaToHex(color: Rgba): string {
  const alpha = color.a < 0.9995 ? channelToHex(color.a) : "";
  return `#${channelToHex(color.r)}${channelToHex(color.g)}${channelToHex(color.b)}${alpha}`;
}

function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value: number): number {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
}

function rgbaToOklch(color: Rgba): Oklch {
  const r = srgbToLinear(color.r);
  const g = srgbToLinear(color.g);
  const b = srgbToLinear(color.b);

  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const lRoot = Math.cbrt(l);
  const mRoot = Math.cbrt(m);
  const sRoot = Math.cbrt(s);

  const okL = 0.2104542553 * lRoot + 0.793617785 * mRoot - 0.0040720468 * sRoot;
  const okA = 1.9779984951 * lRoot - 2.428592205 * mRoot + 0.4505937099 * sRoot;
  const okB = 0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.808675766 * sRoot;

  return {
    l: okL,
    c: Math.sqrt(okA * okA + okB * okB),
    h: (Math.atan2(okB, okA) * 180) / Math.PI,
    a: color.a,
  };
}

function oklchToRgba(color: Oklch): Rgba {
  const angle = (color.h * Math.PI) / 180;
  const okA = color.c * Math.cos(angle);
  const okB = color.c * Math.sin(angle);

  const lRoot = color.l + 0.3963377774 * okA + 0.2158037573 * okB;
  const mRoot = color.l - 0.1055613458 * okA - 0.0638541728 * okB;
  const sRoot = color.l - 0.0894841775 * okA - 1.291485548 * okB;

  const l = lRoot ** 3;
  const m = mRoot ** 3;
  const s = sRoot ** 3;

  return {
    r: linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    a: color.a,
  };
}

function rgbToHsl(color: Rgba): Hsl {
  const max = Math.max(color.r, color.g, color.b);
  const min = Math.min(color.r, color.g, color.b);
  const delta = max - min;
  const l = (max + min) / 2;
  if (delta === 0) return { h: 0, s: 0, l };

  const s = delta / (1 - Math.abs(2 * l - 1));
  const h =
    max === color.r
      ? 60 * (((color.g - color.b) / delta) % 6)
      : max === color.g
        ? 60 * ((color.b - color.r) / delta + 2)
        : 60 * ((color.r - color.g) / delta + 4);
  return { h: normalizeHue(h), s, l };
}

function hslToRgba(color: Hsl, alpha: number): Rgba {
  const chroma = (1 - Math.abs(2 * color.l - 1)) * color.s;
  const x = chroma * (1 - Math.abs(((color.h / 60) % 2) - 1));
  const m = color.l - chroma / 2;
  const [r, g, b] =
    color.h < 60
      ? [chroma, x, 0]
      : color.h < 120
        ? [x, chroma, 0]
        : color.h < 180
          ? [0, chroma, x]
          : color.h < 240
            ? [0, x, chroma]
            : color.h < 300
              ? [x, 0, chroma]
              : [chroma, 0, x];
  return { r: r + m, g: g + m, b: b + m, a: alpha };
}

export function oklchSourceFromHex(input: string): OklchColorValue {
  const parsed = parseHexColor(input);
  if (!parsed) throw new Error("Color must be a six or eight digit hex value");
  const color = rgbaToOklch(parsed);
  return {
    colorSpace: "oklch",
    lightness: Number(color.l.toFixed(6)),
    chroma: Number(color.c.toFixed(6)),
    hue: Number(normalizeHue(color.h).toFixed(6)),
    alpha: Number(color.a.toFixed(6)),
  };
}

/** CSS Color 4 local-MINDE gamut mapping used by source and exporter. */
export function renderOklchSource(source: OklchColorValue): {
  value: string;
  gamutMapped: boolean;
  deltaE: number;
} {
  const initial: Oklch = {
    l: Math.max(0, Math.min(1, source.lightness)),
    c: Math.max(0, source.chroma),
    h: normalizeHue(source.hue),
    a: Math.max(0, Math.min(1, source.alpha)),
  };
  const origin = new Color("oklch", [initial.l, initial.c, initial.h], initial.a);
  const gamutMapped = !origin.inGamut("srgb");
  const mapped = gamutMapped ? origin.clone().toGamut({ space: "srgb", method: "css" }) : origin;
  const srgb = mapped.to("srgb");
  const [rawR, rawG, rawB] = srgb.coords;
  return {
    value: rgbaToHex({
      r: Number(rawR ?? 0),
      g: Number(rawG ?? 0),
      b: Number(rawB ?? 0),
      a: mapped.alpha,
    }),
    gamutMapped,
    deltaE: gamutMapped ? Color.deltaEOK(origin, mapped) : 0,
  };
}

export function deltaEOK(from: string, to: string): number | null {
  if (!parseHexColor(from) || !parseHexColor(to)) return null;
  return Color.deltaEOK(new Color(from), new Color(to));
}

function targetLightness(
  position: AnchorPosition,
  generator: Pick<RampGeneratorSettings, "lightnessMin" | "lightnessMax">,
): number {
  return (
    generator.lightnessMin +
    RAMP_LIGHTNESS_BY_POSITION[position] * (generator.lightnessMax - generator.lightnessMin)
  );
}

export function colorMetricLightness(value: string, mode: RampGeneratorSettings["mode"]): number {
  const parsed = parseHexColor(value);
  if (!parsed) throw new Error("Color must be a six or eight digit hex value");
  return mode === "linear" ? rgbToHsl(parsed).l : rgbaToOklch(parsed).l;
}

export function closestRampPosition(
  baseColor: AuthoredColorValue,
  generator: Pick<RampGeneratorSettings, "mode" | "lightnessMin" | "lightnessMax">,
): AnchorPosition {
  const lightness = colorMetricLightness(baseColor.value, generator.mode);
  return [...ANCHOR_POSITIONS].sort((left, right) => {
    const difference =
      Math.abs(targetLightness(left, generator) - lightness) -
      Math.abs(targetLightness(right, generator) - lightness);
    return difference || Number(left) - Number(right);
  })[0]!;
}

function chromaEnvelope(lightness: number): number {
  return Math.max(0, Math.sin(Math.PI * lightness)) ** 0.72;
}

export function generateColorRamp(
  baseColor: AuthoredColorValue,
  generator: RampGeneratorSettings,
  previousStops: ReadonlyArray<RampStop> = [],
): { basePosition: AnchorPosition; stops: RampStop[] } {
  if (generator.lightnessMin >= generator.lightnessMax)
    throw new Error("Lightness minimum must be lower than lightness maximum");
  if (generator.saturationAdjustment < -1 || generator.saturationAdjustment > 1)
    throw new Error("Saturation adjustment must be between -1 and 1");

  const baseMetric = colorMetricLightness(baseColor.value, generator.mode);
  if (baseMetric < generator.lightnessMin || baseMetric > generator.lightnessMax)
    throw new Error("Lightness bounds must contain the Base color");

  const basePosition = closestRampPosition(baseColor, generator);
  const previous = new Map(previousStops.map((stop) => [stop.position, stop]));
  const parsedBase = parseHexColor(baseColor.value);
  if (!parsedBase) throw new Error("Color must be a six or eight digit hex value");
  const baseHsl = rgbToHsl(parsedBase);
  const baseSource = baseColor.source;
  const baseEnvelope = Math.max(0.000001, chromaEnvelope(baseSource.lightness));

  const stops = ANCHOR_POSITIONS.map((position): RampStop => {
    if (position === basePosition)
      return {
        position,
        source: structuredClone(baseSource),
        value: baseColor.value,
        generated: true,
        overridden: false,
      };

    const existing = previous.get(position);
    if (existing?.overridden) return structuredClone(existing);
    const lightness = targetLightness(position, generator);

    if (generator.mode === "linear") {
      const value = rgbaToHex(
        hslToRgba(
          {
            h: baseHsl.h,
            s: Math.max(0, Math.min(1, baseHsl.s + generator.saturationAdjustment)),
            l: lightness,
          },
          parsedBase.a,
        ),
      );
      return {
        position,
        value,
        source: oklchSourceFromHex(value),
        generated: true,
        overridden: false,
      };
    }

    const neutral = baseSource.chroma < NEUTRAL_CHROMA_THRESHOLD;
    const source: OklchColorValue = {
      ...baseSource,
      lightness,
      chroma: neutral
        ? 0
        : Math.max(
            0,
            baseSource.chroma *
              (chromaEnvelope(lightness) / baseEnvelope) *
              (1 + generator.saturationAdjustment),
          ),
      hue: neutral ? 0 : baseSource.hue,
    };
    return {
      position,
      source,
      value: renderOklchSource(source).value,
      generated: true,
      overridden: false,
    };
  });

  return { basePosition, stops };
}

function interpolateHue(from: number, to: number, amount: number): number {
  const delta = ((to - from + 540) % 360) - 180;
  return from + delta * amount;
}

export function interpolateOklch(from: string, to: string, amount: number): string {
  const fromRgba = parseHexColor(from);
  const toRgba = parseHexColor(to);
  if (!fromRgba || !toRgba) throw new Error("Colors must be six or eight digit hex values");

  const start = rgbaToOklch(fromRgba);
  const end = rgbaToOklch(toRgba);
  const t = Math.max(0, Math.min(1, amount));
  const chromatic = start.c > 0.0001 && end.c > 0.0001;

  return rgbaToHex(
    oklchToRgba({
      l: start.l + (end.l - start.l) * t,
      c: start.c + (end.c - start.c) * t,
      h: chromatic ? interpolateHue(start.h, end.h, t) : start.c > end.c ? start.h : end.h,
      a: start.a + (end.a - start.a) * t,
    }),
  );
}

export function materializeIntermediateStop(
  stops: ReadonlyArray<{ position: RampPosition; value: string }>,
  position: RampPosition,
): string | null {
  const exact = stops.find((stop) => stop.position === position);
  if (exact) return exact.value;

  const target = Number(position);
  const sorted = [...stops].sort((left, right) => Number(left.position) - Number(right.position));
  const lower = [...sorted].reverse().find((stop) => Number(stop.position) < target);
  const upper = sorted.find((stop) => Number(stop.position) > target);
  if (!lower || !upper) return null;

  const amount =
    (target - Number(lower.position)) / (Number(upper.position) - Number(lower.position));
  return interpolateOklch(lower.value, upper.value, amount);
}

export function composite(foreground: Rgba, background: Rgba): Rgba {
  const alpha = foreground.a + background.a * (1 - foreground.a);
  if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 };

  return {
    r: (foreground.r * foreground.a + background.r * background.a * (1 - foreground.a)) / alpha,
    g: (foreground.g * foreground.a + background.g * background.a * (1 - foreground.a)) / alpha,
    b: (foreground.b * foreground.a + background.b * background.a * (1 - foreground.a)) / alpha,
    a: alpha,
  };
}

export function relativeLuminance(color: Rgba): number {
  const r = srgbToLinear(color.r);
  const g = srgbToLinear(color.g);
  const b = srgbToLinear(color.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(
  foreground: string,
  background: string,
  canvas = "#ffffff",
): number | null {
  const foregroundRgba = parseHexColor(foreground);
  const backgroundRgba = parseHexColor(background);
  const canvasRgba = parseHexColor(canvas);
  if (!foregroundRgba || !backgroundRgba || !canvasRgba) return null;

  const opaqueCanvas = composite(canvasRgba, { r: 1, g: 1, b: 1, a: 1 });
  const renderedBackground = composite(backgroundRgba, opaqueCanvas);
  const renderedForeground = composite(foregroundRgba, renderedBackground);
  const lighter = Math.max(
    relativeLuminance(renderedForeground),
    relativeLuminance(renderedBackground),
  );
  const darker = Math.min(
    relativeLuminance(renderedForeground),
    relativeLuminance(renderedBackground),
  );

  return Number(((lighter + 0.05) / (darker + 0.05)).toFixed(2));
}
