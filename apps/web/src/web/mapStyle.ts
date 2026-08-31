import type { StyleSpecification } from "maplibre-gl";

/**
 * Soso's map skin: a cute, pastel-Korean-app look layered onto OpenFreeMap's
 * free "Liberty" vector style, instead of raw OpenStreetMap tiles.
 *
 * WHY THIS NEEDS VECTOR TILES, NOT A CSS FILTER
 * ----------------------------------------------
 * OpenStreetMap's default raster tiles are pre-rendered PNGs — the colours
 * are baked into the image, so there is no way to recolour water, parks, or
 * roads independently short of a global hue filter that would wreck the pin
 * markers sitting on top of them too. Getting an actual palette — soft cream
 * land, mint parks, powder-blue water, muted-mauve major roads — requires a
 * *vector* tile source, where each feature type is its own styleable layer.
 *
 * WHY LIBERTY, NOT POSITRON
 * -------------------------
 * This project started on OpenFreeMap's "Positron" style specifically
 * because it strips POI icons and labels entirely, which made for a much
 * smaller recolour job. That turned out to be the wrong trade: with no
 * landmark names at all — no station names, no shops, no restaurants — the
 * map became hard to navigate by, which defeats the point of a location app.
 * Liberty carries the actual OpenMapTiles `poi` layer, with `class`/
 * `subclass` fields per point, which is what makes filtering it down to a
 * short, deliberate list of categories (rather than showing every POI OSM
 * has ever recorded) possible at all. See `POI_CATEGORY_FILTER` below — the
 * fix is not "turn all POIs on," it's "turn on exactly four kinds."
 *
 * WHY THIS RECOLOURS THE FETCHED STYLE IN JS RATHER THAN HOSTING A REWRITTEN
 * STYLE.JSON
 * ----------------------------------------------
 * Embedding a full forked copy of Liberty's ~80 layers here would work, but
 * it would silently drift from upstream (bug fixes, schema changes) with no
 * way to notice. Fetching the live style and patching a short, explicit list
 * of layer ids means Soso only owns the *differences* — the palette and the
 * POI filter — and inherits everything else OpenFreeMap maintains.
 *
 * Layer ids, filters, and field names below were read directly from the live
 * style (https://tiles.openfreemap.org/styles/liberty) while building this,
 * not guessed from documentation — Liberty and Positron do not share road or
 * land layer ids even though both come from the same OpenMapTiles schema, so
 * nothing from the Positron-era version of this file could be reused
 * directly. If OpenFreeMap renames or restructures layers, entries here
 * simply stop matching and that layer quietly reverts to Liberty's default
 * colour — worth an occasional diff against the live style if the map's
 * colours or landmarks ever look partially unstyled.
 *
 * ONE THING THAT COULD NOT BE VERIFIED
 * -------------------------------------
 * The `subclass` values used in `FILTER_ADDITIONS` ("convenience",
 * "department_store", "restaurant") are inferred from OpenMapTiles' own
 * schema documentation, which states that `subclass` preserves the *raw*
 * OSM tag value (so `shop=convenience` should produce `subclass=convenience`
 * verbatim). This was not confirmed against real tile data — nothing in the
 * environment that built this can query a live vector tile's actual field
 * contents. If a category silently shows nothing, this is the first place
 * to check: the OpenMapTiles tile schema reference has the authoritative
 * class/subclass mapping if these strings turn out to be wrong.
 */

const LIBERTY_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";

/** Layer id -> paint properties to override. Left untouched: layout, zoom ranges. */
const PAINT_OVERRIDES: Record<string, Record<string, unknown>> = {
  // Land
  background: { "background-color": "#fdf3e6" },
  park: { "fill-color": "#ddf1df", "fill-outline-color": "#c9e8cd" },
  park_outline: { "line-color": "#c9e8cd" },
  landcover_wood: { "fill-color": "#d3ecd6" },
  landcover_grass: { "fill-color": "#ddf1df" },
  landuse_residential: { "fill-color": "#fbeee0" },
  landuse_school: { "fill-color": "#eef3da" },
  landuse_hospital: { "fill-color": "#fbe4ec" },

  // Water
  water: { "fill-color": "#bfe6f2" },
  waterway_river: { "line-color": "#a7dcee" },
  waterway_other: { "line-color": "#a7dcee" },
  waterway_tunnel: { "line-color": "#c3e5f0" },
  water_name_point_label: { "text-color": "#5f92ad" },
  water_name_line_label: { "text-color": "#5f92ad" },
  waterway_line_label: { "text-color": "#8fb9cf" },

  // Buildings. building-3d (fill-extrusion) is hidden below rather than
  // recoloured — an extruded, shaded building sits oddly against an
  // otherwise flat illustrative palette with no other shading anywhere.
  building: { "fill-color": "#f6e7d8", "fill-outline-color": "#edd2b8" },

  // ---------------------------------------------------------------------
  // Roads. Redesigned around one idea: small streets should read as bright
  // and easy to trace, big roads should read as a distinct, muted "this is
  // infrastructure" tone — the same functional split Google's white/grey
  // convention makes, kept inside this app's warm palette rather than
  // switching to literal cool grey. Liberty already separates every road
  // class into a wider "casing" line (drawn first, larger) and a narrower
  // "inner" line on top, so the visible colour is mostly the casing at
  // normal zoom and the inner line shows through as a thin core — the same
  // two-tone approach the previous Positron-based version used.
  // ---------------------------------------------------------------------

  // Minor streets and service roads: white core, a soft warm taupe casing
  // for definition. This is the direct fix for "streets are hard to see":
  // the earlier Positron-based palette put minor roads in a tan close in
  // tone to the land underneath them, so they visually disappeared.
  road_minor: { "line-color": "#ffffff" },
  road_minor_casing: { "line-color": "#e6d9c9" },
  road_service_track: { "line-color": "#ffffff" },
  road_service_track_casing: { "line-color": "#e6d9c9" },
  road_path_pedestrian: { "line-color": "#fdf6ec" },

  // Secondary/tertiary/primary/trunk: a muted warm rose-grey rather than
  // white or a saturated accent colour — legible as "a bigger road than
  // that one" without competing with the coral used for report pins.
  road_secondary_tertiary: { "line-color": "#dcc9c2" },
  road_secondary_tertiary_casing: { "line-color": "#c2a89e" },
  road_trunk_primary: { "line-color": "#dcc9c2" },
  road_trunk_primary_casing: { "line-color": "#c2a89e" },
  road_link: { "line-color": "#dcc9c2" },
  road_link_casing: { "line-color": "#c2a89e" },

  // Motorways: the same family, one step more saturated, so the hierarchy
  // still reads at a glance from motorway down to residential street.
  road_motorway: { "line-color": "#c9a89e" },
  road_motorway_casing: { "line-color": "#a9847a" },
  road_motorway_link: { "line-color": "#c9a89e" },
  road_motorway_link_casing: { "line-color": "#a9847a" },

  // Rail: soft lavender instead of neutral grey, matching the rest of the
  // palette rather than reading as generic infrastructure grey.
  road_major_rail: { "line-color": "#ddc8ec" },
  road_major_rail_hatching: { "line-color": "#ddc8ec" },
  road_transit_rail: { "line-color": "#ddc8ec" },
  road_transit_rail_hatching: { "line-color": "#ddc8ec" },

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

  // Landmark labels — the actual point of switching to Liberty. Recoloured
  // to the same plum-brown family as every other label, rather than
  // Liberty's default neutral grey, so they read as part of this map
  // instead of a different one pasted underneath it. Icon sprites are left
  // at Liberty's own colours: OpenFreeMap's sprite sheet is a plain raster
  // image, not a tintable SDF one, so a paint-level colour override would
  // have no effect on the icons themselves, only the text beside them.
  poi_r1: { "text-color": "#7a5c45" },
  poi_r7: { "text-color": "#7a5c45" },
  poi_r20: { "text-color": "#7a5c45" },
  poi_transit: { "text-color": "#0f766e" },
};

/**
 * Additional filter conditions, ANDed onto whatever a layer already filters
 * on. This is the mechanism that turns "Liberty shows every POI OSM has"
 * into "Soso shows train stations, department stores, convenience stores,
 * and restaurants" — narrowing, not replacing, so each layer's existing
 * zoom-based rank staging (busier categories only appear once you are
 * zoomed in far enough) still applies on top of the category restriction.
 */
const FILTER_ADDITIONS: Record<string, unknown> = {
  // poi_r1/r7/r20 together cover every POI class at increasing zoom levels
  // as their "rank" (OpenMapTiles' own local-importance score) allows. The
  // added filter is identical on all three: same four categories, whichever
  // rank tier a given point happens to fall into.
  poi_r1: ["in", ["get", "subclass"], ["literal", ["department_store", "convenience", "restaurant"]]],
  poi_r7: ["in", ["get", "subclass"], ["literal", ["department_store", "convenience", "restaurant"]]],
  poi_r20: ["in", ["get", "subclass"], ["literal", ["department_store", "convenience", "restaurant"]]],

  // poi_transit ships filtering to class in [airport, bus, rail] with no
  // rank restriction at all (transit stops are considered important enough
  // to show regardless of local rank). Narrowed to rail only — train
  // stations were asked for; bus stops and airports were not, and adding
  // them back is a one-line change here if that changes.
  poi_transit: ["==", ["get", "class"], "rail"],
};

/**
 * Layer ids hidden outright. Administrative boundaries are the single
 * biggest contributor to a "government map" feel — a country/prefecture
 * outline has no purpose on a hyperlocal reporting map. Airport/runway
 * layers are dead weight for the same reason: irrelevant at neighbourhood
 * zoom. building-3d is hidden for a different reason — see the comment
 * above the `building` paint override.
 */
const HIDDEN_LAYERS = new Set([
  "boundary_2",
  "boundary_3",
  "boundary_disputed",
  "aeroway_fill",
  "aeroway_runway",
  "aeroway_taxiway",
  "airport",
  "building-3d",
]);

interface LooseLayer {
  id: string;
  paint?: Record<string, unknown>;
  layout?: Record<string, unknown>;
  filter?: unknown;
  [key: string]: unknown;
}

/** Fetches OpenFreeMap's Liberty style and returns Soso's recoloured, filtered copy of it. */
export async function loadCuteMapStyle(): Promise<StyleSpecification> {
  const response = await fetch(LIBERTY_STYLE_URL);
  if (!response.ok) {
    throw new Error(`Failed to load base map style: ${response.status}`);
  }
  const style = (await response.json()) as StyleSpecification;
  const layers = (style.layers as unknown as LooseLayer[]).map((layer) => {
    if (HIDDEN_LAYERS.has(layer.id)) {
      return { ...layer, layout: { ...layer.layout, visibility: "none" } };
    }

    let next = layer;

    const extraFilter = FILTER_ADDITIONS[layer.id];
    if (extraFilter) {
      next = {
        ...next,
        filter: next.filter ? ["all", next.filter, extraFilter] : extraFilter,
      };
    }

    const overrides = PAINT_OVERRIDES[layer.id];
    if (overrides) {
      next = { ...next, paint: { ...next.paint, ...overrides } };
    }

    return next;
  });

  return { ...style, layers } as unknown as StyleSpecification;
}
