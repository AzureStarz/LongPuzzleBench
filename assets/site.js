(() => {
  "use strict";

  document.documentElement.classList.add("has-site-js");

  document.querySelectorAll(".global-header").forEach((header) => {
    const toggle = header.querySelector("[data-nav-toggle]");
    const navigation = header.querySelector(".global-nav");
    if (!toggle || !navigation) return;

    const setOpen = (open) => {
      header.dataset.menuOpen = String(open);
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", open ? "Close project navigation" : "Open project navigation");
    };

    toggle.addEventListener("click", () => setOpen(header.dataset.menuOpen !== "true"));
    navigation.addEventListener("click", (event) => {
      if (event.target.closest("a")) setOpen(false);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        setOpen(false);
        toggle.focus();
      }
    });
    document.addEventListener("pointerdown", (event) => {
      if (header.dataset.menuOpen === "true" && !header.contains(event.target)) setOpen(false);
    });
    window.addEventListener("resize", () => {
      if (window.innerWidth > 820) setOpen(false);
    }, { passive: true });
    setOpen(false);
  });

  const headers = document.querySelectorAll(".global-header");
  const updateHeader = () => {
    headers.forEach((header) => {
      header.dataset.scrolled = String(window.scrollY > 12);
    });
  };
  window.addEventListener("scroll", updateHeader, { passive: true });
  updateHeader();

  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    }, { rootMargin: "0px 0px -7%", threshold: 0.08 });
    document.querySelectorAll(".reveal").forEach((element) => observer.observe(element));
  }
})();
