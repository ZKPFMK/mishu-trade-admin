import { useEffect, useState, type ReactNode } from "react";

export type Theme = "dark" | "light";
const themeKey = "mishu.trade-admin.theme";

export function useAppearance() {
  const [theme, setTheme] = useState<Theme>(
    document.documentElement.dataset.theme === "light" ? "light" : "dark",
  );
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.classList.toggle("dark", theme === "dark");
    root.classList.toggle("light", theme === "light");
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "dark" ? "#0a0a0b" : "#f7f7f5");
    try {
      localStorage.setItem(themeKey, theme);
    } catch {
      /* Storage may be disabled. */
    }
  }, [theme]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === themeKey || event.key === null)
        setTheme(event.newValue === "light" ? "light" : "dark");
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  return {
    theme,
    toggleTheme: () => setTheme((t) => (t === "dark" ? "light" : "dark")),
  };
}

const icons = {
  overview: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  submissions: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6M8 12h8M8 16h6" />
    </>
  ),
  reviews: (
    <>
      <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </>
  ),
  playground: (
    <>
      <path d="M9 3h6M10 3v6l-6 10a1.3 1.3 0 0 0 1.1 2h13.8a1.3 1.3 0 0 0 1.1-2L14 9V3M7 15h10" />
    </>
  ),
  policies: (
    <>
      <path d="M4 6h7m4 0h5M4 12h3m4 0h9M4 18h11m4 0h1" />
      <circle cx="13" cy="6" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="17" cy="18" r="2" />
    </>
  ),
  applications: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="2" />
      <rect x="14" y="3" width="7" height="7" rx="2" />
      <rect x="3" y="14" width="7" height="7" rx="2" />
      <path d="M17.5 14v7M14 17.5h7" />
    </>
  ),
  audit: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2m-4.9-9.1 1.4 1.4M4.5 19.5l1.4-1.4m0-12.2L4.5 4.5m13.6 13.6 1.4 1.4" />
    </>
  ),
  moon: <path d="M20.8 13A9 9 0 0 1 11 3.2 9 9 0 1 0 20.8 13Z" />,
  refresh: (
    <>
      <path d="M20 7a9 9 0 0 0-15-2L3 8m0-5v5h5M4 17a9 9 0 0 0 15 2l2-3m0 5v-5h-5" />
    </>
  ),
  logout: (
    <>
      <path d="M9 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M10 12h11m-4-4 4 4-4 4" />
    </>
  ),
  arrow: (
    <>
      <path d="M4 12h16m-6-6 6 6-6 6" />
    </>
  ),
  lock: (
    <>
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
    </>
  ),
} satisfies Record<string, ReactNode>;
export type IconName = keyof typeof icons;
export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      className="icon"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {icons[name]}
    </svg>
  );
}

export function Brand() {
  return (
    <a
      className="brand"
      href="#workspace"
      aria-label="密树科技 MiShu 交易管理工作台"
    >
      <img
        className="brand-mark"
        src="/mishu-mark.svg"
        width="36"
        height="36"
        alt=""
      />
      <span className="brand-copy">
        <span className="brand-name">
          密树科技 <span>MiShu</span>
        </span>
        <small>交易管理工作台</small>
      </span>
    </a>
  );
}

export function ThemeToggle({
  theme,
  toggleTheme,
}: {
  theme: Theme;
  toggleTheme: () => void;
}) {
  const label = theme === "dark" ? "切换浅色模式" : "切换深色模式";
  return (
    <button
      type="button"
      className="icon-button"
      onClick={toggleTheme}
      aria-label={label}
      title={label}
    >
      <Icon name={theme === "dark" ? "sun" : "moon"} />
    </button>
  );
}
