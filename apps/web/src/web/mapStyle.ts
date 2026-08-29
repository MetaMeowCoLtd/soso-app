import type { StyleSpecification } from "maplibre-gl";

/**
 * Soso's map skin: a cute, pastel-Korean-app look layered onto OpenFreeMap's
 * free "Positron" vector style, instead of raw OpenStreetMap tiles.
 *
 * WHY THIS NEEDS VECTOR TILES, NOT A CSS FILTER
 * ----------------------------------------------
 * OpenStreetMap's default raster tiles are pre-rendered PNGs — the colours
 * are baked into the image, so there is no way to recolour water, parks, or
 * roads independently short of a global hue filter that would wreck the pin
 * markers sitting on top of them too. Getting an actual palette — soft cream
 * land, mint parks, powder-blue water, coral roads — requires a *vector* tile
 * source, where each feature type is its own styleable layer, plus a style
 * that assigns colours per layer.
 *
 * OpenFreeMap (https://openfreemap.org) serves exactly that, for free, with
 * no API key and no usage limit. Positron is its already-minimal style — no
 * POI icons, few labels — which made it a much smaller recolour job than
 * starting from "Liberty" or "Bright", which carry far more layers.
 *
 * WHY THIS RECOLOURS THE FETCHED STYLE IN JS RATHER THAN HOSTING A REWRITTEN
 * STYLE.JSON
 * ----------------------------------------------
 * Embedding a full forked copy of Positron's ~60 layers here would work, but
 * it would silently drift from upstream (bug fixes, schema changes) with no
 * way to notice. Fetching the live style and patching a short, explicit list
 * of layer ids means Soso only owns the *differences* — the palette — and
 * inherits everything else OpenFreeMap maintains.
 *
 * Layer ids below were read directly from the live style
 * (https://tiles.openfreemap.org/styles/positron) while building this, not
 * guessed from documentation. If OpenFreeMap renames or restructures layers,
 * entries here simply stop matching and that layer quietly reverts to
 * Positron's default grey — worth an occasional diff against the live style
 * if the map's colours ever look partially unstyled.
 */

const POSITRON_STYLE_URL = "https://tiles.openfreemap.org/styles/positron";

/** Layer id -> paint properties to override. Left untouched: layout, filters, zoom ranges. */
const PAINT_OVERRIDES: Record<string, Record<string, unknown>> = {
  // Land
  background: { "background-color": "#fdf3e6" },
  park: { "fill-color": "#ddf1df" },
  landcover_wood: { "fill-color": "#d3ecd6" },
  landuse_residential: { "fill-color": "#fbeee0" },
  landcover_ice_shelf: { "fill-color": "#f5eee3" },
  landcover_glacier: { "fill-color": "#f0e6f5" },

  // Water
  water: { "fill-color": "#bfe6f2" },
  waterway: { "line-color": "#a7dcee" },
  water_name_point_label: { "text-color": "#5f92ad" },
  water_name_line_label: { "text-color": "#5f92ad" },
  waterway_line_label: { "text-color": "#8fb9cf" },

  // Buildings
  building: { "fill-color": "#f6e7d8", "fill-outline-color": "#edd2b8" },

  // Roads — minor
  highway_path: { "line-color": "#f0dcc7" },
  highway_minor: { "line-color": "#f5e1cb" },

  // Roads — primary/secondary/tertiary/trunk: coral casing, warm-white centre
  highway_major_casing: { "line-color": "#f3b6a3" },
  highway_major_inner: { "line-color": "#fff8f0" },
  highway_major_subtle: { "line-color": "#f6c7b6" },

  // Motorways: a slightly deeper coral so the road hierarchy still reads
  highway_motorway_casing: { "line-color": "#ee9c92" },
  highway_motorway_inner: { "line-color": "#fff2ea" },
  highway_motorway_subtle: { "line-color": "#f2a99c" },

  // Rail: soft lavender instead of neutral grey
  railway: { "line-color": "#ddc8ec" },
  railway_dashline: { "line-color": "#fdf8fc" },
  railway_service: { "line-color": "#ddc8ec" },
  railway_service_dashline: { "line-color": "#fdf8fc" },
  railway_transit: { "line-color": "#ddc8ec" },
  railway_transit_dashline: { "line-color": "#fdf8fc" },

  // Road name labels
  "highway-name-major": { "text-color": "#a97a5a" },
  "highway-name-minor": { "text-color": "#b58f76" },
  "highway-name-path": { "text-color": "#b58f76" },

  // Place labels — warm plum-brown instead of black, still legible on cream
  label_other: { "text-color": "#8a6a52" },
  label_village: { "text-color": "#7a5c45" },
  label_town: { "text-color": "#7a5c45" },
  label_city: { "text-color": "#5f4633" },
  label_city_capital: { "text-color": "#5f4633" },
  label_state: { "text-color": "#8a6a52" },
  label_country_1: { "text-color": "#5f4633" },
  label_country_2: { "text-color": "#5f4633" },
  label_country_3: { "text-color": "#8a6a52" },
};

/**
 * Layer ids hidden outright. Administrative boundaries are the single
 * biggest contributor to a "government map" feel — a country/prefecture
 * outline has no purpose on a hyperlocal reporting map. Airport/runway
 * layers are dead weight for the same reason: irrelevant at neighbourhood
 * zoom, and their casing colours would otherwise need separate overrides.
 */
const HIDDEN_LAYERS = new Set([
  "boundary_2",
  "boundary_3",
  "boundary_disputed",
  "aeroway-taxiway",
  "aeroway-runway-casing",
  "aeroway-runway",
  "aeroway-area",
  "airport",
]);

interface LooseLayer {
  id: string;
  paint?: Record<string, unknown>;
  layout?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Fetches OpenFreeMap's Positron style and returns Soso's recoloured copy of it. */
export async function loadCuteMapStyle(): Promise<StyleSpecification> {
  const response = await fetch(POSITRON_STYLE_URL);
  if (!response.ok) {
    throw new Error(`Failed to load base map style: ${response.status}`);
  }
  const style = (await response.json()) as StyleSpecification;
  const layers = (style.layers as unknown as LooseLayer[]).map((layer) => {
    if (HIDDEN_LAYERS.has(layer.id)) {
      return { ...layer, layout: { ...layer.layout, visibility: "none" } };
    }
    const overrides = PAINT_OVERRIDES[layer.id];
    if (!overrides) return layer;
    return { ...layer, paint: { ...layer.paint, ...overrides } };
  });

  return { ...style, layers } as unknown as StyleSpecification;
}
