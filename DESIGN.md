# Design

## Source of truth
- Status: Active
- Last refreshed: 2026-08-28
- Primary product surfaces: project homepage (`/`), trajectory research story (`/research/`), and human playground (`/play/`).
- Evidence reviewed: `README.md`, `leaderboard/results.json`, `configs/longpuzzlebench.json`, `playground/`, `blog/longpuzzlebench-agents/`, `scripts/build_pages.py`, browser integration tests, all checked-in game and trajectory visuals, and the live [GameWorld project page](https://gameworld-project.github.io/) with its public source.

## Brand
- Personality: precise, editorial, curious, and quietly playful.
- Trust signals: real puzzle states, recorded trajectories, concrete benchmark numbers, reproducible evidence links, and clear separation between the human playground and agent evaluation.
- Avoid: generic AI imagery, robots or mascots, glowing neural graphics, inflated claims, glass-heavy imitation of the reference site, and decorative motion without state meaning.

## Product goals
- Goals: make LongPuzzleBench understandable within one viewport; expose Research and Play as primary paths; show that the benchmark is active, empirical, and reproducible; make all public surfaces feel like one project.
- Non-goals: a paper replica, exhaustive per-cell result tables, CMS, backend, embedded evaluator, or homepage-loaded Cocos runtime.
- Success signals: a first-time visitor can identify the benchmark, the leading configurations, the first behavioral divergence in a real run, the trajectory findings, and playable games within roughly 30 seconds.

## Personas and jobs
- Primary personas: AI-agent researchers, benchmark users, engineers evaluating GUI agents, and technically curious visitors arriving from GitHub or social media.
- User jobs: understand the benchmark quickly; inspect evidence and results; read the trajectory analysis; try representative games; find source code and protocol details.
- Key contexts of use: desktop research browsing, laptop reading, and mobile link discovery.

## Information architecture
- Primary navigation: Home, Research, Playground, Benchmark, Updates, GitHub.
- Core routes/screens: `/`, `/research/`, `/play/`; Benchmark and Updates are durable homepage anchors; deeper results and protocol documentation remain repository links until dedicated routes exist.
- Content hierarchy: identity and actions → recent updates → benchmark properties → game suite → complete result hierarchy → matched trajectory cases → research synthesis → play invitation → resources.

## Design principles
- Reality first: actual game states and trajectory evidence provide the visual identity.
- Claims lead, visuals prove: headings communicate the takeaway; each major section gets one relevant visual proof.
- Small interfaces, long consequences: numbered states, paths, arrows, forks, and persistent-state motifs distinguish LongPuzzleBench from other game benchmarks.
- Progressive depth: visitors encounter games before aggregate results, then move from score hierarchy to concrete behavior, recurring findings, Research, and the exact playable state.
- Cohesion without sameness: navigation, tokens, buttons, widths, and footer are shared; Research keeps an editorial reading layout and Playground stays compact and game-focused.
- Tradeoffs: prefer a few high-value visuals over exhaustive galleries; prefer static previews and deep links over loading heavy interactive bundles on Home.

## Visual language
- Color: warm paper (`#f2eee5`), off-white surface (`#fbf9f4`), dark blue-green ink (`#16272e`), terracotta accent (`#a7442d`), restrained navy, sage, and gold. Game screenshots supply most saturated color.
- Typography: system serif for editorial display headings, system sans for interface/body text, monospace for scores, dates, steps, and technical metadata.
- Spacing/layout rhythm: 1360px wide shell, 1180px editorial breakout, 760px prose; section padding scales from 4rem on mobile to 8rem on wide screens; body copy stays near 60–70 characters.
- Shape/radius/elevation: 6–18px radii, thin low-contrast borders, sparse soft shadows, pill shapes reserved for buttons/chips rather than every surface.
- Motion: 160–260ms interaction feedback; slower trajectory state changes only when they communicate progress; no hidden-content dependency; respect `prefers-reduced-motion`.
- Imagery/iconography: portrait puzzle screenshots, real trajectory frames, simple arrows and numbered states. No generic stock or AI conceptual art on primary project surfaces.

## Components
- Existing components to reuse: Playground catalog and deep-link contract, lazy runtime iframe, trajectory players, game preview WebPs, article figure/caption patterns, dot wordmark, button and metadata treatments.
- New/changed components: shared global header/mobile menu, shared footer, homepage state-ribbon hero, compact update feed, property strip, game showcase, best-setting-per-model frontier, canonical 18-configuration ranking, synchronized trajectory casebook, research atlas, and resource links.
- Variants and states: primary/secondary/text buttons; current navigation item; expandable mobile menu; trajectory case/moment, playing/paused/reduced-motion states; Playground loading/running/success/failure states.
- Token/component ownership: shared public-shell tokens and navigation/footer styles live in `assets/site.css`; page-specific layout stays with `assets/home.css`, `playground/styles.css`, and `blog/longpuzzlebench-agents/styles.css`.

## Accessibility
- Target standard: practical WCAG 2.2 AA behavior and contrast for public pages.
- Keyboard/focus behavior: visible gold focus ring; semantic links/buttons; mobile menu button exposes `aria-expanded`; trajectory controls remain keyboard operable.
- Contrast/readability: body text on paper/surface remains dark; muted text is not used for critical instructions; prose width is constrained.
- Screen-reader semantics: one page-level `h1`, ordered headings, landmarks, semantic ordered rankings, real tabs, meaningful image alternatives, labelled figures, and status regions for game loading.
- Reduced motion and sensory considerations: disable autoplay and state-transition animation under reduced motion; never rely on color or hover alone.

## Responsive behavior
- Supported breakpoints/devices: wide desktop, laptop, tablet, and mobile down to 320px; principal layout changes near 1080px, 820px, and 560px.
- Layout adaptations: hero state ribbon becomes a compact horizontal/stacked exhibit; the leaderboard becomes three-row mobile records; synchronized trajectory branches become a deliberate horizontal snap comparison; mobile navigation becomes a real menu; game screenshots stay large enough to read.
- Touch/hover differences: actions remain visible without hover; galleries may scroll horizontally only when the affordance is clear; targets are at least 44px where practical.

## Interaction states
- Loading: the homepage loads no game runtime; trajectory WebPs lazy-load and only the active case is preloaded; Playground shows its existing board loader only after selection.
- Empty: unavailable optional content falls back to readable copy and direct links.
- Error: trajectory/article load errors keep captions and evidence links; unknown Pages routes return a project-aware 404 rather than silently opening Play.
- Success: Playground retains its completion status and toast.
- Disabled: autoplay controls explain reduced-motion disabling.
- Offline/slow network: critical identity and copy render without JavaScript; images use dimensions, lazy loading, and async decoding below the fold.

## Content voice
- Tone: direct, concrete, evidence-led, and concise.
- Terminology: “games,” “levels,” “complete runs/configurations,” “recorded model output,” “executed action,” “public feedback,” “evaluator outcome,” “trajectory,” “legal action,” “state,” and “future moves.” Do not call 18 configurations 18 unique models or evaluator state a model observation.
- Microcopy rules: make headings carry the claim; use active CTA labels; avoid AGI claims, generic benchmark superlatives, and repetitive marketing language.

## Implementation constraints
- Framework/styling system: dependency-free static HTML/CSS/JS assembled by `scripts/build_pages.py`; preserve the current stack.
- Design-token constraints: one lightweight shared shell, no component library or token-generation pipeline.
- Performance constraints: keep the complete Pages artifact under the existing 12MiB cap; use existing small WebPs; generate homepage data from canonical JSON; lazy-load below-fold imagery; never load `/runtime/` from Home.
- Compatibility constraints: all internal deployment URLs remain relative and work below the `/LongPuzzleBench/` repository subpath; no backend or SPA-only refresh dependency.
- Test/screenshot expectations: static reference audit, targeted browser tests, full build/verifiers, lint, Python tests, game-model tests, and screenshots at desktop/tablet/mobile before completion.

## Open questions
- [ ] Publish a Paper action only after the technical report has a real URL and citation metadata.
- [ ] Add a dedicated `/results/` route only when it provides more value than the repository leaderboard and machine-readable files.
