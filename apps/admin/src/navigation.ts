import { useEffect, useSyncExternalStore } from "react";
const keys = new Set([
  "app",
  "q",
  "status",
  "from",
  "to",
  "page",
  "position",
  "cursor",
  "detail",
  "case_id",
  "owner",
  "state",
  "inbox",
  "target_id",
  "account_id",
  "actor_id",
  "action",
  "object_id",
  "before",
  "tab",
  "trade_id",
]);
const subscribe = (fn: () => void) => {
  window.addEventListener("hashchange", fn);
  return () => window.removeEventListener("hashchange", fn);
};
export function useRoute() {
  const hash = useSyncExternalStore(subscribe, () => location.hash);
  const [page, query = ""] = hash.slice(1).split("?");
  return {
    page: page || "overview",
    params: Object.fromEntries(
      [...new URLSearchParams(query)].filter(
        ([k, v]) => keys.has(k) && v.length <= 1800,
      ),
    ),
  };
}
export function href(
  page: string,
  app: string,
  params: Record<string, unknown> = {},
) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries({ app, ...params }))
    if (keys.has(key) && value !== undefined && value !== null && value !== "")
      query.set(key, String(value));
  return "#" + page + (query.size ? "?" + query : "");
}
export function navigate(
  page: string,
  app: string,
  params: Record<string, unknown> = {},
) {
  location.hash = href(page, app, params);
}
export function useQuery(app: string) {
  const route = useRoute();
  return {
    params: route.params,
    update: (patch: Record<string, unknown>, reset = false) => {
      const next = href(route.page, app, {
        ...(reset ? {} : route.params),
        ...patch,
        app,
      });
      if (patch.cursor && patch.cursor !== route.params.cursor) {
        try {
          sessionStorage.setItem(`mishu-prev:${next}`, location.hash);
        } catch {
          /* The first page remains available. */
        }
      }
      location.hash = next;
    },
  };
}
export const pageNumber = (value?: string) =>
  Math.min(1000, Math.max(1, Math.floor(Number(value) || 1)));
export function useRememberRoute(app: string) {
  const { page, params } = useRoute();
  useEffect(() => {
    if (!app || (params.app && params.app !== app)) return;
    try {
      sessionStorage.setItem(
        `mishu-nav:${app}:${page}`,
        href(page, app, params),
      );
    } catch {
      /* Navigation still works without storage. */
    }
  }, [app, page, JSON.stringify(params)]);
}
export function rememberedHref(page: string, app: string) {
  try {
    const saved = sessionStorage.getItem(`mishu-nav:${app}:${page}`);
    if (saved?.startsWith(`#${page}?`)) return saved;
  } catch {
    /* Use the clean route. */
  }
  return href(page, app);
}
export function clearNavigation() {
  try {
    for (const key of Object.keys(sessionStorage))
      if (key.startsWith("mishu-nav:") || key.startsWith("mishu-prev:"))
        sessionStorage.removeItem(key);
  } catch {
    /* No persisted routes. */
  }
}

export function previousListPage(app: string) {
  const [page] = location.hash.slice(1).split("?");
  try {
    const previous = sessionStorage.getItem(`mishu-prev:${location.hash}`);
    if (
      previous?.startsWith(`#${page}?`) &&
      new URLSearchParams(previous.split("?")[1]).get("app") === app
    ) {
      location.hash = previous;
      return;
    }
  } catch {
    /* A shared cursor link may have no preceding page in this session. */
  }
  const query = Object.fromEntries(
    new URLSearchParams(location.hash.split("?")[1] || ""),
  );
  navigate(page, app, { ...query, cursor: undefined, page: undefined });
}
