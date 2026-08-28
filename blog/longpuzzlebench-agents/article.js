(() => {
  "use strict";

  const DATA_URL = "data/findings.json";
  const EMBEDDED_DATA_KEY = "LONGPUZZLEBENCH_FINDINGS";
  const AUTOPLAY_MS = 2900;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function displayRun(run) {
    return String(run)
      .replace("gpt-5.6-", "")
      .replace("qwen3.8-27b", "Qwen 3.8 27B")
      .replace("kimi-k3-", "Kimi K3 · ")
      .replace(/-(low|medium|high)$/, " · $1");
  }

  function populateMetrics(data) {
    const values = {
      "public-runs": data.meta.public_runs,
      "executed-trajectories": data.meta.executed_trajectories,
      "failed-trajectories": data.meta.failed_trajectories,
    };
    for (const [name, value] of Object.entries(values)) {
      document.querySelectorAll(`[data-metric="${name}"]`).forEach((node) => {
        node.textContent = Number(value).toLocaleString("en-US");
      });
    }
  }

  function buildPanel(story) {
    const panel = element("section", "trajectory-panel");
    panel.dataset.tone = story.tone;
    panel.setAttribute("aria-label", `${story.label}: ${displayRun(story.run)} trajectory`);

    const head = element("div", "panel-head");
    const title = element("span", "panel-title", story.label);
    const run = element("span", "panel-run", displayRun(story.run));
    head.append(title, run);

    const stage = element("div", "frame-stage");
    const image = element("img", "frame-image");
    image.loading = "lazy";
    image.decoding = "async";
    const overlays = element("div", "frame-overlays");
    overlays.setAttribute("aria-hidden", "true");
    stage.append(image, overlays);

    const copy = element("div", "frame-copy");
    const fact = element("span", "frame-fact");
    const description = element("p", "frame-description");
    const step = element("span", "frame-step");
    copy.append(fact, description, step);

    panel.append(head, stage, copy);
    return { panel, image, overlays, fact, description, step };
  }

  function showPanelFrame(view, story, index) {
    const frame = story.frames[index % story.frames.length];
    view.image.src = frame.asset;
    view.image.alt = `${frame.description} Recorded ${displayRun(story.run)} trajectory, ${frame.kind === "pre" ? "before" : "after"} action ${frame.step}.`;
    view.fact.textContent = frame.fact;
    view.description.textContent = frame.description;
    view.step.textContent = `${frame.kind === "pre" ? "Before" : "After"} action ${frame.step} · ${story.success ? "episode success" : story.termination.replaceAll("_", " ")}`;
    view.overlays.replaceChildren();

    for (const annotation of frame.overlays || []) {
      const overlay = element("div", "frame-overlay");
      overlay.dataset.tone = annotation.tone || "note";
      overlay.style.left = `${annotation.x}%`;
      overlay.style.top = `${annotation.y}%`;
      overlay.style.width = `${annotation.width}%`;
      overlay.style.height = `${annotation.height}%`;
      overlay.append(element("span", "", annotation.label));
      view.overlays.append(overlay);
    }
  }

  function buildPlayer(container, stories, className) {
    const frameCount = Math.max(...stories.map((story) => story.frames.length));
    const player = element("div", className);
    const panels = element("div", "comparison-panels");
    const views = stories.map((story) => {
      const view = buildPanel(story);
      panels.append(view.panel);
      return view;
    });

    const controls = element("div", "player-controls");
    const previous = element("button", "player-button", "←");
    previous.type = "button";
    previous.setAttribute("aria-label", "Show previous trajectory state");
    const toggle = element("button", "player-button player-toggle", "Pause");
    toggle.type = "button";
    const dots = element("div", "player-dots");
    dots.setAttribute("role", "group");
    dots.setAttribute("aria-label", "Trajectory states");
    const next = element("button", "player-button", "→");
    next.type = "button";
    next.setAttribute("aria-label", "Show next trajectory state");
    controls.append(previous, toggle, dots, next);
    player.append(panels, controls);
    container.replaceChildren(player);

    let index = 0;
    let timer = null;
    let visible = false;
    let userPaused = false;
    let hoverPaused = false;

    const dotButtons = Array.from({ length: frameCount }, (_, dotIndex) => {
      const dot = element("button", "player-dot");
      dot.type = "button";
      dot.setAttribute("aria-label", `Show trajectory state ${dotIndex + 1}`);
      dot.addEventListener("click", () => {
        userPaused = true;
        show(dotIndex);
        updateAutoplay();
      });
      dots.append(dot);
      return dot;
    });

    function show(nextIndex) {
      index = (nextIndex + frameCount) % frameCount;
      views.forEach((view, storyIndex) => {
        const story = stories[storyIndex];
        showPanelFrame(view, story, Math.min(index, story.frames.length - 1));
      });
      dotButtons.forEach((dot, dotIndex) => {
        const active = dotIndex === index;
        dot.classList.toggle("is-active", active);
        dot.setAttribute("aria-current", active ? "step" : "false");
      });
      if (visible) {
        stories.forEach((story) => {
          const nextFrame = story.frames[Math.min((index + 1) % frameCount, story.frames.length - 1)];
          const preload = new Image();
          preload.src = nextFrame.asset;
        });
      }
    }

    function stop() {
      if (timer) window.clearInterval(timer);
      timer = null;
    }

    function updateToggle() {
      const disabled = reducedMotion.matches;
      toggle.disabled = disabled;
      toggle.textContent = disabled || userPaused ? "Play" : "Pause";
      toggle.setAttribute("aria-label", disabled
        ? "Autoplay disabled by reduced-motion preference"
        : userPaused ? "Play trajectory animation" : "Pause trajectory animation");
      toggle.setAttribute("aria-pressed", String(!userPaused && !disabled));
    }

    function updateAutoplay() {
      stop();
      const shouldPlay = visible && !userPaused && !hoverPaused && !reducedMotion.matches && !document.hidden;
      if (shouldPlay) timer = window.setInterval(() => show(index + 1), AUTOPLAY_MS);
      updateToggle();
    }

    previous.addEventListener("click", () => {
      userPaused = true;
      show(index - 1);
      updateAutoplay();
    });
    next.addEventListener("click", () => {
      userPaused = true;
      show(index + 1);
      updateAutoplay();
    });
    toggle.addEventListener("click", () => {
      if (reducedMotion.matches) return;
      userPaused = !userPaused;
      updateAutoplay();
    });
    player.addEventListener("pointerenter", () => {
      hoverPaused = true;
      updateAutoplay();
    });
    player.addEventListener("pointerleave", () => {
      hoverPaused = false;
      updateAutoplay();
    });
    player.addEventListener("focusin", () => {
      hoverPaused = true;
      updateAutoplay();
    });
    player.addEventListener("focusout", (event) => {
      if (!player.contains(event.relatedTarget)) {
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
      const observer = new IntersectionObserver((entries) => {
        visible = entries.some((entry) => entry.isIntersecting && entry.intersectionRatio > 0.2);
        updateAutoplay();
      }, { threshold: [0, 0.2, 0.6] });
      observer.observe(player);
    } else {
      visible = true;
    }

    show(0);
    updateToggle();
  }

  function renderPlayers(data) {
    document.querySelectorAll(".trajectory-comparison[data-left][data-right]").forEach((container) => {
      const left = data.stories[container.dataset.left];
      const right = data.stories[container.dataset.right];
      if (!left || !right) {
        container.textContent = "Recorded comparison is unavailable.";
        return;
      }
      buildPlayer(container, [left, right], "comparison-player");
    });

    document.querySelectorAll(".trajectory-player-shell[data-story]").forEach((container) => {
      const story = data.stories[container.dataset.story];
      if (!story) {
        container.textContent = "Recorded trajectory is unavailable.";
        return;
      }
      buildPlayer(container, [story], "single-player");
    });
  }

  function renderLoadFailure() {
    const message = "The recorded evidence bundle could not be loaded. Keep data/findings.js beside this article.";
    document.querySelectorAll(".trajectory-comparison, .trajectory-player-shell").forEach((container) => {
      const fallback = container.querySelector(".visual-loading") || element("p", "visual-loading");
      fallback.textContent = message;
      if (!fallback.parentNode) container.append(fallback);
    });
  }

  function readingProgress() {
    const indicator = document.querySelector(".reading-progress span");
    if (!indicator) return;
    let queued = false;
    const update = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const progress = max > 0 ? window.scrollY / max : 0;
      indicator.style.transform = `scaleX(${Math.min(1, Math.max(0, progress))})`;
      queued = false;
    };
    window.addEventListener("scroll", () => {
      if (!queued) {
        queued = true;
        window.requestAnimationFrame(update);
      }
    }, { passive: true });
    update();
  }

  async function init() {
    readingProgress();
    try {
      let data = window[EMBEDDED_DATA_KEY];
      if (!data) {
        const response = await fetch(DATA_URL);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        data = await response.json();
      }
      populateMetrics(data);
      renderPlayers(data);
    } catch (error) {
      console.error("LongPuzzleBench evidence failed to load", error);
      renderLoadFailure();
    }
  }

  init();
})();
