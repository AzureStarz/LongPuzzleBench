(() => {
  "use strict";

  const payload = window.LONGPUZZLEBENCH_HOME_DATA;
  const casebook = document.querySelector("[data-casebook]");
  if (!payload || !casebook || !Array.isArray(payload.cases) || !payload.cases.length) return;

  const stage = casebook.querySelector("[data-case-stage]");
  const tabs = [...casebook.querySelectorAll("[data-case-tab]")];
  const branches = [...casebook.querySelectorAll("[data-case-branch]")];
  const previous = casebook.querySelector("[data-case-prev]");
  const next = casebook.querySelector("[data-case-next]");
  const toggle = casebook.querySelector("[data-case-toggle]");
  const moment = casebook.querySelector("[data-case-moment]");
  const count = casebook.querySelector("[data-case-output-count]");
  const dots = casebook.querySelector("[data-case-dots]");
  const researchLink = casebook.querySelector("[data-case-research]");
  const playLink = casebook.querySelector("[data-case-play]");

  if (
    !stage ||
    tabs.length !== payload.cases.length ||
    branches.length !== 2 ||
    !previous ||
    !next ||
    !toggle ||
    !moment ||
    !count ||
    !dots ||
    !researchLink ||
    !playLink
  ) return;

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const intervalMs = 5200;
  let caseIndex = 0;
  let frameIndex = 0;
  let timer = null;
  let visible = false;
  let userPaused = false;
  let interactionPaused = false;

  function currentCase() {
    return payload.cases[caseIndex];
  }

  function setLinkLabel(link, label) {
    link.textContent = `${label} `;
    const arrow = document.createElement("span");
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "→";
    link.append(arrow);
  }

  function replaceImage(image, frame, model) {
    const alt = `${model}: ${frame.description}`;
    if (image.getAttribute("src") === frame.asset) {
      image.alt = alt;
      return;
    }
    image.classList.add("is-changing");
    image.addEventListener("load", () => image.classList.remove("is-changing"), { once: true });
    image.src = frame.asset;
    image.alt = alt;
    if (image.complete) window.requestAnimationFrame(() => image.classList.remove("is-changing"));
  }

  function outputLanguage(value) {
    return /[\u3400-\u9fff]/u.test(value) ? "zh" : "en";
  }

  function branchElements(branch) {
    return {
      label: branch.querySelector("[data-branch-label]"),
      model: branch.querySelector("[data-branch-model]"),
      rank: branch.querySelector("[data-branch-rank]"),
      thesis: branch.querySelector("[data-branch-thesis]"),
      outcome: branch.querySelector("[data-branch-outcome]"),
      image: branch.querySelector("[data-case-image]"),
      state: branch.querySelector("[data-case-state-label]"),
      output: branch.querySelector("[data-case-output]"),
      action: branch.querySelector("[data-case-action]"),
      fact: branch.querySelector("[data-case-fact]"),
      description: branch.querySelector("[data-case-description]"),
      feedback: branch.querySelector("[data-case-feedback]"),
    };
  }

  const branchNodes = branches.map(branchElements);
  if (branchNodes.some((nodes) => Object.values(nodes).some((node) => !node))) return;

  function renderFrame(nextIndex) {
    const selectedCase = currentCase();
    const frameCount = selectedCase.branches[0].frames.length;
    frameIndex = Math.max(0, Math.min(nextIndex, frameCount - 1));

    selectedCase.branches.forEach((branch, branchIndex) => {
      const nodes = branchNodes[branchIndex];
      const frame = branch.frames[frameIndex];
      const timing = frame.kind === "pre" ? "Before action" : "After action";
      const omitted = frame.omitted_before ? ` · ${frame.omitted_before} omitted` : "";
      replaceImage(nodes.image, frame, branch.model);
      nodes.state.textContent = `${timing} ${String(frame.step).padStart(2, "0")}${omitted}`;
      nodes.output.textContent = frame.recorded_output || "No output excerpt selected.";
      nodes.output.lang = outputLanguage(nodes.output.textContent);
      nodes.action.textContent = frame.action;
      nodes.fact.textContent = frame.fact;
      nodes.description.textContent = frame.description;
      nodes.feedback.textContent = `Public feedback · ${frame.feedback.replaceAll("_", " ")}`;
    });

    const activeFrame = selectedCase.branches[0].frames[frameIndex];
    moment.textContent = activeFrame.moment;
    count.textContent = `${String(frameIndex + 1).padStart(2, "0")} / ${String(frameCount).padStart(2, "0")}`;
    previous.disabled = frameIndex === 0;
    next.disabled = frameIndex === frameCount - 1;
    [...dots.children].forEach((dot, index) => {
      if (index === frameIndex) dot.setAttribute("aria-current", "step");
      else dot.removeAttribute("aria-current");
    });
    stage.dataset.caseFrame = String(frameIndex);
  }

  function buildDots() {
    const selectedCase = currentCase();
    dots.replaceChildren();
    selectedCase.branches[0].frames.forEach((frame, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `Moment ${index + 1}: ${frame.moment}`;
      button.setAttribute("aria-label", `Show moment ${index + 1}: ${frame.moment}`);
      button.addEventListener("click", () => {
        userPaused = true;
        renderFrame(index);
        updateAutoplay();
      });
      dots.append(button);
    });
  }

  function renderCase(nextCaseIndex) {
    caseIndex = Math.max(0, Math.min(nextCaseIndex, payload.cases.length - 1));
    frameIndex = 0;
    const selectedCase = currentCase();
    const kicker = stage.querySelector("[data-case-kicker]");
    const title = stage.querySelector("[data-case-title]");
    const summary = stage.querySelector("[data-case-summary]");
    const stat = stage.querySelector("[data-case-stat]");
    const match = stage.querySelector("[data-case-match]");

    kicker.textContent = selectedCase.kicker;
    title.textContent = selectedCase.title;
    summary.textContent = selectedCase.summary;
    stat.textContent = selectedCase.stat;
    match.textContent = selectedCase.matched_initial_frame
      ? `Byte-identical selected frame · SHA ${selectedCase.matched_sha256.slice(0, 10)}`
      : "Matched evaluator state";
    researchLink.href = selectedCase.research;
    playLink.href = selectedCase.play;
    setLinkLabel(researchLink, "Read this finding");
    setLinkLabel(playLink, selectedCase.play_label);
    stage.setAttribute("aria-labelledby", `case-tab-${selectedCase.id}`);
    stage.dataset.caseId = selectedCase.id;

    selectedCase.branches.forEach((branch, branchIndex) => {
      const element = branches[branchIndex];
      const nodes = branchNodes[branchIndex];
      element.className = `trajectory-run trajectory-run--${branch.tone}`;
      nodes.label.textContent = branch.label;
      nodes.model.textContent = branch.model;
      nodes.rank.textContent = `Rank ${branch.rank} · ${branch.benchmark_score.toFixed(3)}`;
      nodes.thesis.textContent = branch.thesis;
      nodes.outcome.textContent = branch.outcome;
    });

    tabs.forEach((tab, index) => {
      const selected = index === caseIndex;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });

    buildDots();
    renderFrame(0);
    casebook.querySelector("[data-case-branches]").scrollTo({ left: 0, behavior: "auto" });
    if (visible) preloadCase(selectedCase);
    updateAutoplay();
  }

  function preloadCase(selectedCase) {
    selectedCase.branches.forEach((branch) => {
      branch.frames.forEach((frame) => {
        const image = new Image();
        image.src = frame.asset;
      });
    });
  }

  function stop() {
    if (timer) window.clearInterval(timer);
    timer = null;
  }

  function shouldPlay() {
    return visible && !userPaused && !interactionPaused && !reducedMotion.matches && !document.hidden;
  }

  function updateControl() {
    if (reducedMotion.matches) {
      toggle.disabled = true;
      toggle.textContent = "Autoplay off";
      toggle.setAttribute("aria-pressed", "false");
      toggle.setAttribute("aria-label", "Autoplay disabled by reduced-motion preference");
      return;
    }
    toggle.disabled = false;
    toggle.textContent = userPaused ? "Play" : "Pause";
    toggle.setAttribute("aria-pressed", String(!userPaused));
    toggle.setAttribute("aria-label", userPaused ? "Play trajectory" : "Pause trajectory");
  }

  function updateAutoplay() {
    stop();
    if (shouldPlay()) {
      timer = window.setInterval(() => {
        const frameCount = currentCase().branches[0].frames.length;
        renderFrame((frameIndex + 1) % frameCount);
      }, intervalMs);
    }
    updateControl();
  }

  previous.addEventListener("click", () => {
    userPaused = true;
    renderFrame(frameIndex - 1);
    updateAutoplay();
  });

  next.addEventListener("click", () => {
    userPaused = true;
    renderFrame(frameIndex + 1);
    updateAutoplay();
  });

  toggle.addEventListener("click", () => {
    if (reducedMotion.matches) return;
    userPaused = !userPaused;
    updateAutoplay();
  });

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => renderCase(index));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      let target = index;
      if (event.key === "ArrowLeft") target = (index - 1 + tabs.length) % tabs.length;
      if (event.key === "ArrowRight") target = (index + 1) % tabs.length;
      if (event.key === "Home") target = 0;
      if (event.key === "End") target = tabs.length - 1;
      renderCase(target);
      tabs[target].focus();
    });
  });

  casebook.addEventListener("pointerenter", () => {
    interactionPaused = true;
    updateAutoplay();
  });

  casebook.addEventListener("pointerleave", () => {
    interactionPaused = false;
    updateAutoplay();
  });

  casebook.addEventListener("focusin", () => {
    interactionPaused = true;
    updateAutoplay();
  });

  casebook.addEventListener("focusout", (event) => {
    if (!casebook.contains(event.relatedTarget)) {
      interactionPaused = false;
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
    let preloadedCase = null;
    const observer = new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting && entry.intersectionRatio > 0.1);
      if (visible && preloadedCase !== currentCase().id) {
        preloadedCase = currentCase().id;
        preloadCase(currentCase());
      }
      updateAutoplay();
    }, { threshold: [0, 0.1, 0.5] });
    observer.observe(casebook);
  } else {
    visible = true;
    preloadCase(currentCase());
  }

  renderCase(0);
})();
