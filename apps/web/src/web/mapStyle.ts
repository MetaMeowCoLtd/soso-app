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
 * WHAT WAS WRONG THE FIRST TIME, AND WHAT IS STILL UNCERTAIN
 * -------------------------------------------------------------
 * An earlier version of this file filtered convenience stores, department
 * stores, and restaurants by ANDing a subclass whitelist onto Liberty's
 * existing poi_r1/r7/r20 layers, which also gate visibility by OpenMapTiles'
 * own "rank" (local-importance) score. Convenience stores showed; most
 * restaurants and department stores did not. The subclass values themselves
 * were confirmed correct against OpenMapTiles' authoritative poi.yaml
 * (github.com/openmaptiles/openmaptiles/blob/master/layers/poi/poi.yaml) —
 * the actual bug was combining a category filter with a rank filter, which
 * meant two categories could require very different zoom levels to appear
 * for reasons unrelated to whether either was useful to show. SOSO_SHOPS_LAYER
 * replaces all three rank-tiered layers with one that filters purely on
 * subclass, at one fixed zoom.
 *
 * What remains genuinely uncertain: whether a train station shows depends
 * on which of "rail" or "railway" its `class` field actually holds in
 * OpenFreeMap's live tiles, and the schema documentation and the deployed
 * style disagree with each other on this — see FILTER_REPLACEMENTS below.
 * Nothing in the environment that built this can query a live vector tile's
 * actual field contents to settle it directly, so the filter hedges across
 * both possibilities rather than betting on one.
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
  poi_transit: { "text-color": "#0f766e" },
};

/**
 * A dedicated landmark layer, built from scratch rather than by filtering
 * Liberty's existing poi_r1/r7/r20 (which this style now hides entirely —
 * see HIDDEN_LAYERS). Those three exist to stagger EVERY OSM POI category
 * across zoom levels by OpenMapTiles' own "rank" (local-importance) score,
 * so a city's most prominent handful of businesses appear before its
 * thousands of minor ones as you zoom in. That staging is the wrong
 * mechanism once the category list is already narrowed to four deliberate
 * kinds: a convenience store and a restaurant sitting on the same street
 * can have very different rank scores for reasons unrelated to whether
 * either one is useful to show, and layering a rank threshold on top of a
 * category filter meant some categories only appeared several zoom levels
 * later than others for no reason a person looking at the map could see.
 * One layer, one minzoom, filtered purely on subclass — every matching
 * point appears at once, and the earlier clutter concern is handled by the
 * category list itself, not by an additional threshold on top of it.
 *
 * subclass values confirmed against OpenMapTiles' authoritative poi.yaml
 * (github.com/openmaptiles/openmaptiles/blob/master/layers/poi/poi.yaml):
 * 'supermarket' and 'department_store' are siblings under one internal
 * grouping; 'convenience' is its own directly-named subclass under the
 * general "shop" grouping; 'restaurant' has no broader class mapping at
 * all, which per the schema's own description means class and subclass are
 * simply identical for it — subclass == "restaurant" was correct from the
 * start, not the source of the earlier problem.
 */
const SOSO_SHOPS_LAYER = {
  id: "soso_shops",
  type: "symbol",
  source: "openmaptiles",
  "source-layer": "poi",
  minzoom: 15,
  filter: [
    "all",
    ["match", ["geometry-type"], ["Point", "MultiPoint"], true, false],
    ["in", ["get", "subclass"], ["literal", ["convenience", "supermarket", "department_store", "restaurant"]]],
  ],
  // icon-image and text-field expressions copied verbatim from Liberty's own
  // poi_r1 layer, not invented — this reuses a rendering pattern already
  // proven to work in the live style rather than guessing at new syntax.
  layout: {
    "icon-image": ["match", ["get", "subclass"], ["florist", "furniture"], ["get", "subclass"], ["get", "class"]],
    "text-anchor": "top",
    "text-field": [
      "case",
      ["has", "name:nonlatin"],
      ["concat", ["get", "name:latin"], "\n", ["get", "name:nonlatin"]],
      ["coalesce", ["get", "name_en"], ["get", "name"]],
    ],
    "text-font": ["Noto Sans Italic"],
    "text-max-width": 9,
    "text-offset": [0, 0.6],
    "text-size": 12,
  },
  paint: {
    "text-color": "#7a5c45",
    "text-halo-blur": 0.5,
    "text-halo-color": "#ffffff",
    "text-halo-width": 1,
  },
};

/**
 * Filters that ADD to whatever a layer already filters on (AND-merged — see
 * loadCuteMapStyle). Only narrowing is possible this way, which is exactly
 * wrong for poi_transit: see FILTER_REPLACEMENTS below for why train
 * stations needed the stronger tool instead.
 */
const FILTER_ADDITIONS: Record<string, unknown> = {};

/**
 * Filters that REPLACE a layer's filter outright, for the one case where
 * narrowing isn't enough: OpenMapTiles' own schema documentation states
 * railway stations get class="railway", but Liberty's live, deployed style
 * filters poi_transit for class in [airport, bus, rail] — "rail", not
 * "railway". Both were read directly from a real source (the schema config
 * vs. the actual fetched style JSON), and they disagree, most likely because
 * OpenFreeMap's tile pipeline diverged from the upstream config at some
 * point. Rather than bet on either being the one that is actually true of
 * OpenFreeMap's data, this checks for both spellings of class AND the raw
 * subclass values ("station", "halt") a railway=station tag would produce,
 * so a station shows up regardless of which convention actually generated
 * the tiles being served right now.
 */
const FILTER_REPLACEMENTS: Record<string, unknown> = {
  poi_transit: [
    "any",
    ["match", ["get", "class"], ["rail", "railway"], true, false],
    ["match", ["get", "subclass"], ["station", "halt"], true, false],
  ],
};

/**
 * Layout property overrides — a separate map from PAINT_OVERRIDES because
 * allow-overlap is a layout property, not a paint one.
 *
 * poi_transit forced to always render regardless of collision with any
 * other label. Train stations are a small, sparse set of points, so
 * forcing them to draw is a low-risk way to close off an entirely different
 * possible cause of a missing station name: MapLibre drops overlapping
 * symbols by draw order, and a station sharing screen space with a place
 * name (very plausible — a station is often at the centre of the area
 * named after it) could be losing that collision even with a perfectly
 * correct filter. Repositioned later in the layer array in
 * loadCuteMapStyle for the same reason: draw order is what decides which
 * label wins a collision in the first place.
 */
const LAYOUT_OVERRIDES: Record<string, Record<string, unknown>> = {
  poi_transit: { "text-allow-overlap": true, "icon-allow-overlap": true },
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
  // Replaced by soso_shops (see above), which filters purely on subclass
  // with no rank gating, so every wanted category appears at one
  // consistent zoom rather than some being pushed several levels higher
  // than others by a local-importance score unrelated to their category.
  "poi_r1",
  "poi_r7",
  "poi_r20",
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
  let layers = (style.layers as unknown as LooseLayer[]).map((layer) => {
    if (HIDDEN_LAYERS.has(layer.id)) {
      return { ...layer, layout: { ...layer.layout, visibility: "none" } };
    }

    let next = layer;

    if (FILTER_REPLACEMENTS[layer.id]) {
      next = { ...next, filter: FILTER_REPLACEMENTS[layer.id] };
    } else {
      const extraFilter = FILTER_ADDITIONS[layer.id];
      if (extraFilter) {
        next = {
          ...next,
          filter: next.filter ? ["all", next.filter, extraFilter] : extraFilter,
        };
      }
    }

    const overrides = PAINT_OVERRIDES[layer.id];
    if (overrides) {
      next = { ...next, paint: { ...next.paint, ...overrides } };
    }

    const layoutOverrides = LAYOUT_OVERRIDES[layer.id];
    if (layoutOverrides) {
      next = { ...next, layout: { ...next.layout, ...layoutOverrides } };
    }

    return next;
  });

  // Insert the landmark layer where poi_r1 used to sit (now hidden), rather
  // than appending it — this keeps it in a sensible position in the draw
  // order instead of defaulting to wherever push() would put it, which for
  // a symbol layer also affects collision priority against neighbouring
  // layers.
  const shopsInsertAt = layers.findIndex((l) => l.id === "poi_r1");
  const shopsLayer = SOSO_SHOPS_LAYER as unknown as LooseLayer;
  layers =
    shopsInsertAt === -1
      ? [...layers, shopsLayer]
      : [...layers.slice(0, shopsInsertAt), shopsLayer, ...layers.slice(shopsInsertAt)];

  // Move train station labels to the very end of the draw order, so their
  // collision priority beats place-name labels that might otherwise claim
  // the same screen space first and silently suppress them — see the
  // comment on LAYOUT_OVERRIDES for why this matters even with
  // allow-overlap already set.
  const transitIdx = layers.findIndex((l) => l.id === "poi_transit");
  if (transitIdx !== -1) {
    const [transitLayer] = layers.splice(transitIdx, 1);
    if (transitLayer) layers.push(transitLayer);
  }

  return { ...style, layers } as unknown as StyleSpecification;
}
