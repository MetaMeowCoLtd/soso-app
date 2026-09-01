// A fixed, vendored replacement for the `leaflet-doubletapdrag` package
// (still imported from npm one level up, in SosoMap.tsx: this only replaces
// the base tap-pair detector, not `leaflet-doubletapdragzoom`, which sits on
// top of it and only cares about the events fired here — not who fires them).
//
// THE BUG
// -------
// The original package (node_modules/leaflet-doubletapdrag/Leaflet.DoubleTapDrag.js,
// unmodified upstream) recognises "two taps" using ONLY elapsed time between
// two `touchstart` events, under a 500ms window. It never checks:
//
//   1. how far apart the two touches landed, or
//   2. whether the FIRST touch was actually a brief, near-stationary tap,
//      as opposed to the start of an ordinary drag.
//
// That second gap is the one that matters here. Panning the map by hand
// naturally produces several quick, separate swipes in a row — touch down,
// drag, lift, touch down again to continue the pan — and consecutive swipes
// routinely start within 500ms of each other. The original code can't tell
// that apart from a genuine double tap: it fires `doubletapdragstart`
// anyway, and `leaflet-doubletapdragzoom`'s handler responds by calling
// `preventDefault()`/`stopPropagation()` on every following `touchmove`,
// which is what actually breaks the pan rather than just misclassifying it.
//
// THE FIX
// -------
// A touch only becomes eligible to start the double-tap window once it has
// ENDED and, at that point, qualifies as an actual tap: short duration
// (`TAP_MAX_DURATION`) and small net movement (`TAP_MAX_MOVEMENT`) between
// its own touchstart and touchend. A second touchstart only counts as
// "tap 2" if it lands within `TAP_MAX_DISTANCE` of that release point, in
// addition to the original time window. A drag — of any length, in any
// number of successive swipes — never produces a qualifying tap in the
// first place, so it can never seed a false double-tap-drag.
//
// `DOUBLE_CLICK_TIMEOUT` (500ms) and `WAIT_FOR_DRAG_END_TIMEOUT` (100ms) are
// kept at the upstream package's own values — `leaflet-doubletapdragzoom`
// was tuned against this same 100ms recognition delay, and there's no
// reason to also relitigate the double-tap timing window while fixing an
// unrelated missing-distance-check bug.
function DoubleTapDragInitHookFixed() {
  var DOUBLE_CLICK_TIMEOUT = 500;
  var WAIT_FOR_DRAG_END_TIMEOUT = 100;
  var TAP_MAX_DURATION = 250; // longer than this, a touch is a press/drag, not a tap
  var TAP_MAX_MOVEMENT = 10; // px of net movement; more than this, it's a drag, not a tap
  var TAP_MAX_DISTANCE = 40; // px; how close tap 2 must land to tap 1's release point

  var timer = null;
  var fired = false;
  // The most recent touch that itself qualified as a tap, once it ended —
  // i.e. what the ORIGINAL plugin's `lastTimestamp` was trying to be, minus
  // the missing "was it actually a tap" and "was it near tap 1" checks.
  var pendingTap = null; // { time, point } | null
  // The touch currently in progress, tracked from its own touchstart so its
  // touchend handler can judge duration/movement for itself.
  var current = null; // { time, point } | null

  function pointOf(touch) {
    return L.point(touch.clientX, touch.clientY);
  }

  this._container.addEventListener(
    "touchstart",
    L.Util.bind(function (e) {
      if (e.touches.length !== 1) {
        // A second simultaneous finger: this is a pinch, not a double-tap
        // sequence. Drop any in-progress tap tracking rather than let a
        // pinch be misread as part of one once it ends.
        pendingTap = null;
        current = null;
        return;
      }

      var now = Date.now();
      var point = pointOf(e.touches[0]);

      if (
        pendingTap &&
        now - pendingTap.time < DOUBLE_CLICK_TIMEOUT &&
        point.distanceTo(pendingTap.point) <= TAP_MAX_DISTANCE
      ) {
        pendingTap = null;
        timer = setTimeout(
          L.Util.bind(function () {
            this.fire("doubletapdragstart", e);
            timer = null;
            fired = true;
          }, this),
          WAIT_FOR_DRAG_END_TIMEOUT,
        );
      }

      current = { time: now, point: point };
    }, this),
  );

  this._container.addEventListener(
    "touchend",
    L.Util.bind(function (e) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (fired) {
        this.fire("doubletapdragend", e);
        fired = false;
      }

      if (current) {
        var duration = Date.now() - current.time;
        // touchend's own `touches` list no longer includes the lifted
        // finger — `changedTouches` is what reports where it came up.
        var releasePoint =
          e.changedTouches && e.changedTouches.length ? pointOf(e.changedTouches[0]) : current.point;
        var moved = releasePoint.distanceTo(current.point);

        pendingTap = duration <= TAP_MAX_DURATION && moved <= TAP_MAX_MOVEMENT ? { time: Date.now(), point: releasePoint } : null;
      }
      current = null;
    }, this),
  );

  this._container.addEventListener(
    "touchmove",
    L.Util.bind(function (e) {
      if (!fired) {
        return;
      }
      this.fire("doubletapdrag", e);
    }, this),
  );
}

L.Map.addInitHook(DoubleTapDragInitHookFixed);
