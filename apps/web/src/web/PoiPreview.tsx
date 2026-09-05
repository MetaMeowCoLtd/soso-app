"use client";

import type { Coordinates } from "./region";

export interface SelectedPoi {
  name: string;
  at: Coordinates;
}

interface PoiPreviewProps {
  poi: SelectedPoi;
  onClose: () => void;
  onAddPin: (at: Coordinates) => void;
}

/**
 * Deliberately much smaller than PinPreview: a POI is a map-tile label
 * (a shop, a station), not an app post — there is no author, no vote, no
 * report, no address lookup, nothing this app itself knows about it beyond
 * the name and coordinates the vector tile already handed over at the
 * click point (see SosoMap's own poiDisplayName, which this reuses the
 * output of rather than re-deriving). The one thing this view exists to
 * do beyond just naming the place: let the tap turn directly into a new
 * pin at that exact spot, instead of requiring a second, separate tap on
 * the same location to start one.
 */
export default function PoiPreview({ poi, onClose, onAddPin }: PoiPreviewProps) {
  return (
    <div className="poi-preview">
      <div className="pin-preview-head">
        <div>
          <p className="composer-kicker pin-preview-kicker">📍 Place</p>
          <p className="poi-preview-name">{poi.name}</p>
        </div>
        <button className="pin-preview-close" onClick={onClose} aria-label="Close" type="button">
          ×
        </button>
      </div>

      <div className="pin-preview-body">
        <button
          className="pin-preview-primary-action"
          type="button"
          onClick={() => onAddPin(poi.at)}
        >
          Add a pin here
        </button>
      </div>
    </div>
  );
}
