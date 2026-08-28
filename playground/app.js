(() => {
  "use strict";

  const catalog = window.LONGPUZZLEBENCH_PLAYGROUND;
  if (!catalog) throw new Error("Playground catalog failed to load");

  const elements = {
    landing: document.querySelector("#landingView"),
    gameView: document.querySelector("#gameView"),
    gameGrid: document.querySelector("#gameGrid"),
    runtime: document.querySelector("#gameRuntime"),
    runtimeFrame: document.querySelector("#runtimeFrame"),
    runtimeLoader: document.querySelector("#runtimeLoader"),
    playEyebrow: document.querySelector("#playEyebrow"),
    playTitle: document.querySelector("#playTitle"),
    mobilePlayTitle: document.querySelector("#mobilePlayTitle"),
    mobilePlayControls: document.querySelector("#mobilePlayControls"),
    playObjective: document.querySelector("#playObjective"),
    playControls: document.querySelector("#playControls"),
    controlIcon: document.querySelector("#controlIcon"),
    levelSelect: document.querySelector("#levelSelect"),
    levelEvidence: document.querySelector("#levelEvidence"),
    actionCount: document.querySelector("#actionCount"),
    attemptState: document.querySelector("#attemptState"),
    statusText: document.querySelector("#statusText"),
    liveStatus: document.querySelector("#liveStatus"),
    reset: document.querySelector("#resetGame"),
    back: document.querySelector("#backToGallery"),
    another: document.querySelector("#tryAnother"),
    completionToast: document.querySelector("#completionToast"),
    completionCopy: document.querySelector("#completionCopy"),
  };

  const aliases = new Map([
    ["maze", "maze-paint"],
    ["maze_paint", "maze-paint"],
    ["bolt", "bolt-unscrew"],
    ["bolt_unscrew", "bolt-unscrew"],
    ["car-escape", "rush-hour"],
    ["car_escape", "rush-hour"],
    ["rush-hour-2", "rush-hour"],
    ["rush_hour_2", "rush-hour"],
    ["truck_escape_2", "rush-hour"],
    ["nuts-bolts", "nut-and-bolt"],
    ["nuts_bolts", "nut-and-bolt"],
    ["nut_and_bolt", "nut-and-bolt"],
    ["truck_escape", "truck-escape"],
    ["color_connect", "color-connect"],
  ]);

  let activeGame = null;
  let activeLevel = null;
  let monitorTimer = null;
  let loadGeneration = 0;
  let lastStatus = null;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function levelFor(game, key, difficulty, number) {
    return (
      game.levels.find((level) => key && level.key === key) ||
      game.levels.find(
        (level) =>
          difficulty &&
          level.difficulty === difficulty &&
          Number.isFinite(number) &&
          level.level === number,
      ) ||
      game.levels.find((level) => level.key === game.defaultLevel) ||
      game.levels[0]
    );
  }

  function gameFor(rawSlug) {
    const slug = aliases.get(rawSlug) || rawSlug;
    return catalog.games.find((game) => game.slug === slug) || null;
  }

  function defaultLevel(game) {
    return levelFor(game, game.defaultLevel);
  }

  function renderGallery() {
    const cards = catalog.games.map((game, index) => {
      const level = defaultLevel(game);
      const card = element("article", "game-card");
      card.style.setProperty("--game-accent", game.accent);
      card.style.setProperty("--card-index", String(index));

      const preview = element("div", "game-preview");
      const image = element("img");
      image.src = game.preview;
      image.alt = `${game.name} puzzle preview`;
      image.loading = "lazy";
      image.decoding = "async";
      const interaction = element("span", "preview-badge", game.interaction);
      preview.append(image, interaction);

      const body = element("div", "game-card-body");
      const meta = element("p", "game-meta", `${game.challenge} · ${level.label.split("·").at(-1).trim()}`);
      const name = element("h3", "", game.name);
      const objective = element("p", "game-objective", game.shortObjective);
      const facts = element("div", "game-facts");
      facts.append(
        element("span", "", level.cardEvidence),
        element("span", "", `${game.levels.length} curated levels`),
      );
      const button = element("button", "card-play", "Play");
      button.type = "button";
      button.dataset.launch = game.slug;
      button.setAttribute("aria-label", `Play ${game.name}`);
      body.append(meta, name, objective, facts, button);
      card.append(preview, body);
      return card;
    });
    elements.gameGrid.replaceChildren(...cards);
  }

  function updateGameCopy(game, level) {
    elements.playEyebrow.textContent = `${game.interaction} puzzle · ${level.difficulty} ${level.level}`;
    elements.playTitle.textContent = game.name;
    elements.mobilePlayTitle.textContent = game.name;
    elements.mobilePlayControls.textContent = `${game.interaction}: ${game.controls}`;
    elements.playObjective.textContent = game.objective;
    elements.playControls.textContent = game.controls;
    elements.controlIcon.textContent = game.controlIcon;
    elements.levelEvidence.textContent = level.evidence;
    elements.runtime.title = `${game.name}, ${level.label}`;
    document.title = `${game.name} · Play LongPuzzleBench`;

    const options = game.levels.map((optionLevel) => {
      const option = element("option", "", optionLevel.label);
      option.value = optionLevel.key;
      option.selected = optionLevel.key === level.key;
      return option;
    });
    elements.levelSelect.replaceChildren(...options);
  }

  function setAttemptStatus(status, actions = 0) {
    const labels = {
      loading: ["Loading puzzle", "Loading"],
      running: ["Puzzle ready", actions === 0 ? "Ready" : "In progress"],
      success: ["Puzzle solved", "Solved"],
      failure: ["Attempt ended", "Ended"],
      unavailable: ["Runtime unavailable", "Unavailable"],
    };
    const [live, attempt] = labels[status] || labels.loading;
    elements.statusText.textContent = live;
    elements.attemptState.textContent = attempt;
    elements.liveStatus.dataset.status = status;
    elements.runtimeFrame.dataset.status = status;
  }

  function stopMonitoring() {
    if (monitorTimer) window.clearInterval(monitorTimer);
    monitorTimer = null;
  }

  function readBridgeState() {
    try {
      const bridge = elements.runtime.contentWindow?.__LONGPUZZLEBENCH_PLAY__;
      return bridge && typeof bridge.getState === "function" ? bridge.getState() : null;
    } catch (_) {
      return null;
    }
  }

  function monitorRuntime(generation) {
    stopMonitoring();
    const startedAt = performance.now();
    monitorTimer = window.setInterval(() => {
      if (generation !== loadGeneration || !activeGame) return;
      const state = readBridgeState();
      if (!state) {
        if (performance.now() - startedAt > 20_000) {
          setAttemptStatus("unavailable");
          elements.runtimeLoader.querySelector("strong").textContent = "The board did not start";
          elements.runtimeLoader.querySelector("small").textContent =
            "Refresh this attempt or try another puzzle.";
        }
        return;
      }

      const actions = Number.isFinite(Number(state.step_count)) ? Number(state.step_count) : 0;
      elements.actionCount.textContent = actions.toLocaleString("en-US");
      if (state.ready) elements.runtimeFrame.classList.add("is-ready");
      const status = state.status || (state.ready ? "running" : "loading");
      setAttemptStatus(status, actions);

      if (status !== lastStatus && status === "success") {
        elements.completionCopy.textContent = `Completed in ${actions} ${actions === 1 ? "action" : "actions"}.`;
        elements.completionToast.hidden = false;
      }
      lastStatus = status;
    }, 250);
  }

  function runtimeUrl(game, level, generation) {
    const url = new URL("../runtime/index.html", window.location.href);
    url.searchParams.set("playground", "1");
    url.searchParams.set("game_id", game.runtimeId);
    url.searchParams.set("difficulty", level.difficulty);
    url.searchParams.set("level_id", String(level.level));
    url.searchParams.set("seed", "0");
    url.searchParams.set("attempt", String(generation));
    return url.href;
  }

  function loadRuntime({ replace = false } = {}) {
    if (!activeGame || !activeLevel) return;
    loadGeneration += 1;
    const generation = loadGeneration;
    lastStatus = null;
    stopMonitoring();
    elements.runtimeFrame.classList.remove("is-ready");
    elements.completionToast.hidden = true;
    elements.actionCount.textContent = "0";
    setAttemptStatus("loading");
    elements.runtime.src = runtimeUrl(activeGame, activeLevel, generation);
    monitorRuntime(generation);
    syncUrl(replace);
  }

  function syncUrl(replace) {
    if (!activeGame || !activeLevel) return;
    const url = new URL(window.location.href);
    url.searchParams.set("game", activeGame.slug);
    url.searchParams.set("difficulty", activeLevel.difficulty);
    url.searchParams.set("level", String(activeLevel.level));
    url.searchParams.delete("level_id");
    const method = replace ? "replaceState" : "pushState";
    window.history[method]({ game: activeGame.slug, level: activeLevel.key }, "", url);
  }

  function showGame(game, level, options = {}) {
    activeGame = game;
    activeLevel = level;
    updateGameCopy(game, level);
    elements.landing.hidden = true;
    elements.gameView.hidden = false;
    document.body.classList.add("is-playing");
    window.scrollTo({ top: 0, behavior: options.instant ? "auto" : "smooth" });
    loadRuntime({ replace: options.replace });
  }

  function launchBySlug(slug, options = {}) {
    const game = gameFor(slug);
    if (!game) return;
    const level = levelFor(game, options.levelKey, options.difficulty, options.levelNumber);
    showGame(game, level, options);
  }

  function showGallery({ preserveHistory = false } = {}) {
    stopMonitoring();
    activeGame = null;
    activeLevel = null;
    elements.runtime.src = "about:blank";
    elements.gameView.hidden = true;
    elements.landing.hidden = false;
    elements.completionToast.hidden = true;
    document.body.classList.remove("is-playing");
    document.title = "Play LongPuzzleBench";
    if (!preserveHistory) {
      const url = new URL(window.location.href);
      url.search = "";
      window.history.pushState({}, "", url);
    }
    window.requestAnimationFrame(() => {
      if (preserveHistory) window.scrollTo({ top: 0, behavior: "auto" });
      else document.querySelector("#games")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  function restoreFromUrl({ replace = true } = {}) {
    const params = new URLSearchParams(window.location.search);
    const slug = params.get("game");
    if (!slug) {
      showGallery({ preserveHistory: true });
      window.scrollTo({ top: 0, behavior: "auto" });
      return;
    }
    launchBySlug(slug, {
      difficulty: params.get("difficulty"),
      levelNumber: Number(params.get("level") || params.get("level_id")),
      replace,
      instant: true,
    });
  }

  document.addEventListener("click", (event) => {
    const launch = event.target.closest("[data-launch]");
    if (launch) launchBySlug(launch.dataset.launch);
  });
  elements.levelSelect.addEventListener("change", () => {
    if (!activeGame) return;
    activeLevel = levelFor(activeGame, elements.levelSelect.value);
    updateGameCopy(activeGame, activeLevel);
    loadRuntime();
  });
  elements.reset.addEventListener("click", () => loadRuntime({ replace: true }));
  elements.back.addEventListener("click", () => showGallery());
  elements.another.addEventListener("click", () => showGallery());
  document.querySelector("[data-completion-reset]").addEventListener("click", () =>
    loadRuntime({ replace: true }),
  );
  window.addEventListener("popstate", () => restoreFromUrl({ replace: true }));

  renderGallery();
  restoreFromUrl({ replace: true });
})();
