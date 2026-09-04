/**
 * Small single-panel explorers for the tutorial section.
 *
 * The full explorer keeps one module-level `state`, so mounting it three times
 * would give three widgets sharing one parameter vector and one panel. These
 * are separate instances instead: each owns its own theta and redraws only
 * itself.
 *
 * They are also much cheaper. The three physics panels are closed-form (see
 * baqaro-physics.js) and need no emulator at all, so a tutorial explorer costs
 * one 20 KB metadata file for the slider bounds, shared between all three,
 * rather than the ~590 KB of emulator the predicted panels need.
 */

import { drawPanel } from "./baqaro-plot.js";
import {
	FIDUCIAL, LABELS, toDisplay,
	accretionSpec, seedingSpec, variabilitySpec, growthSpec,
	drwVariabilitySpec, drwGrowthSpec,
} from "./baqaro-explorer.js";

const BASE = "assets/emulator";

/** Which sliders each panel actually responds to. */
// The lightcurve level comes from eta_av,0 + eta_av,slope * logSSAR with width
// sigma_acc, and only its block length from log tau: all four matter here.
const PARAMS = { accretion: [0, 1, 2], seeding: [4, 5], variability: [0, 1, 2, 3],
	growth: [0, 1, 2, 3], drw: [0, 1, 2, 3] };
const SPEC = {
	accretion: (theta, extra) => accretionSpec(theta, extra),
	seeding: (theta, extra) => seedingSpec(theta, extra),
	variability: (theta) => variabilitySpec(theta),
	growth: (theta) => growthSpec(theta),
	drw: (theta) => drwVariabilitySpec(theta),
	drwgrowth: (theta) => drwGrowthSpec(theta),
};

/** Fetched once and shared by every instance on the page. */
let metaPromise = null;
function meta() {
	if (!metaPromise) {
		metaPromise = fetch(`${BASE}/emulators.json`)
			.then((r) => r.json())
			.then((d) => d.shared);
	}
	return metaPromise;
}

/** Per-panel reference overlays, each optional and fetched at most once. */
const extras = {};
function extraFor(panel) {
	const file = { accretion: "population_ssar.json", seeding: "bhmf_z0_reference.json" }[panel];
	if (!file) return Promise.resolve(null);
	if (!extras[panel]) {
		extras[panel] = fetch(`${BASE}/${file}`).then((r) => r.json()).catch(() => null);
	}
	return extras[panel];
}

/**
 * Mount one panel into `root`, which must contain a <canvas> and a
 * [data-role=sliders] container. `root.dataset.panel` selects the panel.
 */
export async function initTutorialPanel(root) {
	// A panel may draw more than one canvas from the same parameters: the
	// coherence-time step shows the accretion history and what it builds, and
	// they have to move together to mean anything.
	const panels = root.dataset.panel.split(/\s+/);
	const canvases = [...root.querySelectorAll("canvas")];
	const panel = panels[0];
	const slidersEl = root.querySelector("[data-role=sliders]");
	const theta = FIDUCIAL.slice();

	const shared = await meta();
	const extra = await extraFor(panel);

	const draw = () => panels.forEach((name, i) => {
		if (canvases[i]) drawPanel(canvases[i], SPEC[name](theta, extra));
	});

	PARAMS[panel].forEach((i) => {
		const name = shared.param_names[i];
		const [lo, hi] = shared.param_ranges[i];
		const show = (v) => toDisplay(name, v).toFixed(3);
		const row = document.createElement("div");
		row.className = "slider-row";
		row.innerHTML = `
			<label for="${panel}-p${i}">${LABELS[name] || name}</label>
			<input type="range" id="${panel}-p${i}" min="${lo}" max="${hi}"
			       step="${(hi - lo) / 400}" value="${FIDUCIAL[i]}">
			<output for="${panel}-p${i}">${show(FIDUCIAL[i])}</output>`;
		slidersEl.appendChild(row);
		const input = row.querySelector("input");
		const out = row.querySelector("output");
		input.addEventListener("input", () => {
			theta[i] = parseFloat(input.value);
			out.textContent = show(theta[i]);
			draw();
		});
	});

	const reset = root.querySelector("[data-role=reset]");
	if (reset) {
		reset.addEventListener("click", () => {
			PARAMS[panel].forEach((i) => {
				theta[i] = FIDUCIAL[i];
				const input = root.querySelector(`#${panel}-p${i}`);
				const out = root.querySelector(`output[for="${panel}-p${i}"]`);
				input.value = FIDUCIAL[i];
				out.textContent = toDisplay(shared.param_names[i], FIDUCIAL[i]).toFixed(3);
			});
			draw();
		});
	}

	draw();
	// keep the canvas backing store in step with its CSS size
	let pending = null;
	window.addEventListener("resize", () => {
		clearTimeout(pending);
		pending = setTimeout(draw, 120);
	});
}

/**
 * Mount every [data-tutorial-panel], but only once it is near the viewport.
 *
 * Building all of them at load put three canvases, their metadata fetch and
 * three first draws in front of the page becoming usable, on top of the main
 * explorer further down. Deferring costs nothing: a panel is set up by the time
 * it is scrolled to, and one never reached is never built.
 */
export function initTutorial() {
	const panels = document.querySelectorAll("[data-tutorial-panel]");
	if (!panels.length) return;

	const mount = (el) => {
		if (el.dataset.mounted) return;
		el.dataset.mounted = "1";
		initTutorialPanel(el).catch((err) => {
			console.error("tutorial panel failed", err);
			el.hidden = true;            // fall back to the prose alone
		});
	};

	if (!("IntersectionObserver" in window)) {
		panels.forEach(mount);           // old browser: just build them
		return;
	}
	const io = new IntersectionObserver((entries) => {
		entries.forEach((e) => {
			if (!e.isIntersecting) return;
			io.unobserve(e.target);
			mount(e.target);
		});
	}, { rootMargin: "300px 0px" });     // a screen ahead, so it is ready on arrival
	panels.forEach((el) => io.observe(el));
}
