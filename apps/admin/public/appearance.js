// Apply the saved theme before the stylesheet paints. Kept external for script-src 'self'.
(() => {
  let theme = "dark";
  try {
    if (localStorage.getItem("mishu.trade-admin.theme") === "light")
      theme = "light";
  } catch {
    /* The default theme also works without browser storage. */
  }
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.add(theme);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#0a0a0b" : "#f7f7f5");
})();
