// Makes Leaflet's scroll-wheel zoom track a Mac trackpad pinch instead of
// fighting its own zoom animation.
//
// THE BUG
// -------
// Mac pinch-to-zoom arrives as `wheel` events (Chrome/Safari set `ctrlKey`).
// Leaflet's ScrollWheelZoom handler then calls `setZoom` / `setZoomAround`
// with the default `{animate: true}`. That starts a ~250ms CSS zoom
// transition and sets `_animatingZoom`. The next wheel burst — tens of
// milliseconds later, well before the transition ends — hits
// `_tryAnimatedZoom`, which bails out with `if (this._animatingZoom) return
// true` and never applies the new delta. `map._stop()` (called from
// `_performZoom`) only cancels pan/flyTo, not the zoom animation, so those
// events are simply dropped.
//
// This was invisible while `zoomSnap` was 1: a pinch accumulated until it
// crossed a whole zoom level, one animation played, and the gesture felt
// like a series of smooth steps. `zoomSnap={0}` (needed so one-handed drag
// zoom does not snap on release — see SosoMap.tsx) makes every burst a tiny
// fractional zoom, so most of the pinch is eaten by an in-flight animation.
// The map hitch-steps instead of following the fingers.
//
// THE FIX
// -------
// Same `_performZoom` math as Leaflet 1.9, but pass `{animate: false}` so
// each burst `_resetView`s immediately. The MapLibre GL layer then follows
// via its `zoom` / `jumpTo` path rather than a CSS transform that gets
// cancelled mid-way. One-handed drag zoom and `flyTo` are untouched: they
// do not go through this handler.
import L from "leaflet";

L.Map.ScrollWheelZoom.include({
  _performZoom: function () {
    var map = this._map;
    var zoom = map.getZoom();
    var snap = this._map.options.zoomSnap || 0;

    map._stop();

    var d2 = this._delta / (this._map.options.wheelPxPerZoomLevel * 4);
    var d3 = (4 * Math.log(2 / (1 + Math.exp(-Math.abs(d2))))) / Math.LN2;
    var d4 = snap ? Math.ceil(d3 / snap) * snap : d3;
    var delta = map._limitZoom(zoom + (this._delta > 0 ? d4 : -d4)) - zoom;

    this._delta = 0;
    this._startTime = null;

    if (!delta) {
      return;
    }

    if (map.options.scrollWheelZoom === "center") {
      map.setZoom(zoom + delta, { animate: false });
    } else {
      map.setZoomAround(this._lastMousePos, zoom + delta, { animate: false });
    }
  },
});
