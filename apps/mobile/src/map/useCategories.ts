import { useEffect, useState } from "react";

import type { CategoryConfig, SosoGateway } from "../core";

export interface UseCategoriesResult {
  categories: CategoryConfig[];
  loading: boolean;
  error: unknown;
}

/**
 * Ported verbatim from apps/web/src/web/hooks.ts's `useCategories` — no
 * browser API involved at all, so nothing about this changes on a native
 * port. A category the server has disabled is simply absent from the
 * response, so the kill switch takes effect on next launch with no client
 * deploy. The client renders whatever it is told and enforces none of it —
 * `create_post` re-checks every rule regardless of what the form allowed.
 */
export function useCategories(gateway: SosoGateway): UseCategoriesResult {
  const [state, setState] = useState<UseCategoriesResult>({
    categories: [],
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    gateway
      .loadCategories()
      .then((categories) => {
        if (!cancelled) setState({ categories, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ categories: [], loading: false, error });
      });
    return () => {
      cancelled = true;
    };
  }, [gateway]);

  return state;
}
