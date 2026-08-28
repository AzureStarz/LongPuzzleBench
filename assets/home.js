(() => {
  "use strict";

  const preview = document.querySelector("[data-trajectory-preview]");
  if (!preview) return;

  const images = {
    failure: preview.querySelector('[data-trajectory-image="failure"]'),
    preserved: preview.querySelector('[data-trajectory-image="preserved"]'),
  };
  const facts = {
    failure: preview.querySelector('[data-trajectory-fact="failure"]'),
    preserved: preview.querySelector('[data-trajectory-fact="preserved"]'),
  };
  const descriptions = {
    failure: preview.querySelector('[data-trajectory-description="failure"]'),
    preserved: preview.querySelector('[data-trajectory-description="preserved"]'),
  };
  const range = preview.querySelector("[data-trajectory-range]");
  const output = preview.querySelector("[data-trajectory-output]");
  const toggle = preview.querySelector("[data-trajectory-toggle]");

  if (
    !images.failure ||
    !images.preserved ||
    !facts.failure ||
    !facts.preserved ||
    !descriptions.failure ||
    !descriptions.preserved ||
    !range ||
    !output ||
    !toggle
  ) return;

  const frames = Object.freeze([
    Object.freeze({
      failure: Object.freeze({
        src: "research/assets/trajectories/bolt_immediate-008-post.webp",
        alt: "Bolt board before the branch that immediately loses all legal moves",
        fact: "Same state · 20.8% progress",
        description: "One uncovered destination remains.",
      }),
      preserved: Object.freeze({
        src: "research/assets/trajectories/bolt_deeper-010-post.webp",
        alt: "The byte-identical Bolt board before a branch that preserves mobility",
        fact: "Same state · 20.8% progress",
        description: "The same destination is open.",
      }),
    }),
    Object.freeze({
      failure: Object.freeze({
        src: "research/assets/trajectories/bolt_immediate-009-post.webp",
        alt: "The agent selects the exposed mid-right support screw",
        fact: "Source: mid-right support",
        description: "The visually salient screw is selected.",
      }),
      preserved: Object.freeze({
        src: "research/assets/trajectories/bolt_deeper-011-post.webp",
        alt: "The comparison run selects a deeper lower-center support screw",
        fact: "Source: lower-center support",
        description: "The comparison chooses a deeper support.",
      }),
    }),
    Object.freeze({
      failure: Object.freeze({
        src: "research/assets/trajectories/bolt_immediate-010-pre.webp",
        alt: "The selected screw is aimed at a legal visibly open destination",
        fact: "The fatal click looks correct",
        description: "The destination is legal and visibly open.",
      }),
      preserved: Object.freeze({
        src: "research/assets/trajectories/bolt_deeper-012-post.webp",
        alt: "After the deeper transfer, an exposed source hole remains available",
        fact: "27.1% progress · mobility survives",
        description: "The same destination preserves a usable source.",
      }),
    }),
    Object.freeze({
      failure: Object.freeze({
        src: "research/assets/trajectories/bolt_immediate-010-post.webp",
        alt: "After physics settles, every empty Bolt source is covered",
        fact: "29.2% progress · 0 legal moves",
        description: "Progress rises; physics covers every empty source.",
      }),
      preserved: Object.freeze({
        src: "research/assets/trajectories/bolt_deeper-020-post.webp",
        alt: "The deeper branch continues through three more transfers before a later deadlock",
        fact: "50.0% progress · later deadlock",
        description: "Three more transfers follow before a later deadlock.",
      }),
    }),
  ]);

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const intervalMs = 3200;
  let index = 0;
  let timer = null;
  let visible = false;
  let userPaused = false;
  let hoverPaused = false;

  function replaceImage(image, next) {
    if (image.getAttribute("src") === next.src) return;
    image.classList.add("is-changing");
    image.addEventListener("load", () => image.classList.remove("is-changing"), { once: true });
    image.src = next.src;
    image.alt = next.alt;
    if (image.complete) window.requestAnimationFrame(() => image.classList.remove("is-changing"));
  }

  function showFrame(nextIndex) {
    index = (nextIndex + frames.length) % frames.length;
    const frame = frames[index];

    for (const branch of ["failure", "preserved"]) {
      replaceImage(images[branch], frame[branch]);
      facts[branch].textContent = frame[branch].fact;
      descriptions[branch].textContent = frame[branch].description;
    }

    range.value = String(index);
    output.textContent = `State ${index + 1} of ${frames.length}`;
    preview.dataset.trajectoryState = String(index);
  }

  function stop() {
    if (timer) window.clearInterval(timer);
    timer = null;
  }

  function shouldPlay() {
    return visible && !userPaused && !hoverPaused && !reducedMotion.matches && !document.hidden;
  }

  function updateControl() {
    if (reducedMotion.matches) {
      toggle.disabled = true;
      toggle.textContent = "Autoplay off";
      toggle.setAttribute("aria-label", "Autoplay disabled by reduced-motion preference");
      toggle.setAttribute("aria-pressed", "false");
      return;
    }

    toggle.disabled = false;
    toggle.textContent = userPaused ? "Play preview" : "Pause preview";
    toggle.setAttribute("aria-label", userPaused ? "Play trajectory preview" : "Pause trajectory preview");
    toggle.setAttribute("aria-pressed", String(!userPaused));
  }

  function updateAutoplay() {
    stop();
    if (shouldPlay()) timer = window.setInterval(() => showFrame(index + 1), intervalMs);
    updateControl();
  }

  function preloadFrames() {
    for (const frame of frames) {
      for (const branch of ["failure", "preserved"]) {
        const image = new Image();
        image.src = frame[branch].src;
      }
    }
  }

  range.addEventListener("input", () => {
    userPaused = true;
    showFrame(Number(range.value));
    updateAutoplay();
  });

  toggle.addEventListener("click", () => {
    if (reducedMotion.matches) return;
    userPaused = !userPaused;
    updateAutoplay();
  });

  preview.addEventListener("pointerenter", () => {
    hoverPaused = true;
    updateAutoplay();
  });

  preview.addEventListener("pointerleave", () => {
    hoverPaused = false;
    updateAutoplay();
  });

  preview.addEventListener("focusin", () => {
    hoverPaused = true;
    updateAutoplay();
  });

  preview.addEventListener("focusout", (event) => {
    if (!preview.contains(event.relatedTarget)) {
      hoverPaused = false;
      updateAutoplay();
    }
  });

  document.addEventListener("visibilitychange", updateAutoplay);
  const motionListener = () => updateAutoplay();
  if (typeof reducedMotion.addEventListener === "function") {
    reducedMotion.addEventListener("change", motionListener);
  } else {
    reducedMotion.addListener(motionListener);
  }

  if ("IntersectionObserver" in window) {
    let preloaded = false;
    const observer = new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting && entry.intersectionRatio > 0.15);
      if (visible && !preloaded) {
        preloaded = true;
        preloadFrames();
      }
      updateAutoplay();
    }, { threshold: [0, 0.15, 0.6] });
    observer.observe(preview);
  } else {
    visible = true;
    preloadFrames();
  }

  showFrame(0);
  updateAutoplay();
})();
