"use client";

import { formatAgo, formatCountdown, type CategoryConfig, type Pin } from "soso-core";
import { lookOf } from "./theme";

/**
 * The list.
 *
 * Rows show category, subtype, age and time remaining — deliberately not the
 * description. `Pin` doesn't carry a body at all: the feed's wire format omits
 * it so that a viewport response stays a few kilobytes instead of tens, and
 * that's the same object this list renders, not a separate fuller fetch. Full
 * text is one click away in the detail panel, the same "tap for detail" split
 * the map markers and the mobile app both use, so seeing a description costs a
 * fetch exactly once, only for the post someone actually opens.
 */

interface ReportListProps {
  pins: Pin[];
  categories: CategoryConfig[];
  selectedId?: string;
  nowSeconds: number;
  onSelect: (pin: Pin) => void;
}

export default function ReportList({ pins, categories, selectedId, nowSeconds, onSelect }: ReportListProps) {
  if (pins.length === 0) return <p className="empty-state">No reports match these filters.</p>;

  return (
    <div className="report-list" aria-live="polite">
      {pins.map((pin) => {
        const category = categories.find((c) => c.key === pin.category);
        const subtype = category?.subtypes.find((s) => s.key === pin.subtype);
        const look = lookOf(pin.category);
        const label = subtype?.labelEn ?? category?.labelEn ?? pin.category;

        return (
          <button
            className={`report-card ${selectedId === pin.id ? "selected" : ""}`}
            key={pin.id}
            onClick={() => onSelect(pin)}
            type="button"
          >
            <span className="report-icon" style={{ backgroundColor: look.color }} aria-hidden="true">
              {look.icon}
            </span>
            <span className="report-main">
              <span className="report-meta">
                {label} · {formatAgo(pin.createdAt, nowSeconds)}
              </span>
              <span>Disappears in {formatCountdown(pin.expiresAt, nowSeconds)}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
