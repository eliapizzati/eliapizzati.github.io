/**
 * BAQARO emulator, in the browser.
 *
 * A direct port of `predict.py`, the reference implementation that ships with
 * the data release. Given six parameters it returns log10 of a summary
 * statistic, in a couple of milliseconds, with no server and no dependencies.
 *
 * The arrays are float32 on the wire (see tools/export_web_emulator.py) but
 * every arithmetic operation here is float64, because that is the only kind of
 * arithmetic JavaScript has -- reading an element out of a Float32Array widens
 * it to a double. So the only error inherited from the export is the storage
 * quantisation of each element: measured at < 2e-3 dex against the float64
 * reference, which is roughly ten times smaller than one plot pixel and fifty
 * times smaller than the emulator's own accuracy against the forward model.
 *
 *   const shared = await loadShared("assets/emulator");
 *   const qlf    = await loadQuantity("assets/emulator", "qlf", shared);
 *   const y      = predict(qlf, [-1.2355, 0.8327, 0.5075, 5.8947, -6.4694, 0.5056]);
 *   //  y is flat; reshape with qlf.outputShape
 */

const SQRT3 = Math.sqrt(3);
const SQRT5 = Math.sqrt(5);

/** Matern covariance from the SQUARED scaled distance. */
export function matern(r2, kind) {
	const r = Math.sqrt(r2 > 0 ? r2 : 0);
	if (kind === "matern32") {
		const a = SQRT3 * r;
		return (1 + a) * Math.exp(-a);
	}
	if (kind === "matern52") {
		const a = SQRT5 * r;
		return (1 + a + (a * a) / 3) * Math.exp(-a);
	}
	if (kind === "matern12") return Math.exp(-r);
	throw new Error(`unknown kernel type ${kind}`);
}

async function fetchFloat32(url) {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
	return new Float32Array(await res.arrayBuffer());
}

/** Load the manifest plus the training design, shared by every quantity. */
export async function loadShared(base) {
	const res = await fetch(`${base}/emulators.json`);
	if (!res.ok) throw new Error(`${base}/emulators.json: HTTP ${res.status}`);
	const manifest = await res.json();
	const s = manifest.shared;
	const [nTrain, nParams] = s.X_train;
	const X = await fetchFloat32(`${base}/${s.file}`);
	if (X.length !== nTrain * nParams) {
		throw new Error(`shared.bin has ${X.length} floats, expected ${nTrain * nParams}`);
	}
	return {
		manifest,
		X, nTrain, nParams,
		paramNames: s.param_names,
		paramRanges: s.param_ranges,
		scalerMean: s.scaler_mean,
		scalerScale: s.scaler_scale,
	};
}

/** Load one quantity's big arrays and bind them to the shared design. */
export async function loadQuantity(base, name, shared) {
	const meta = shared.manifest.quantities[name];
	if (!meta) throw new Error(`no emulator named ${name}`);
	const buf = await fetchFloat32(`${base}/${meta.file}`);

	// slice the concatenated buffer using the shapes the manifest records
	const parts = {};
	let off = 0;
	for (const { name: key, shape } of meta.layout) {
		const n = shape.reduce((a, b) => a * b, 1);
		parts[key] = buf.subarray(off, off + n);
		off += n;
	}
	if (off !== buf.length) {
		throw new Error(`${name}.bin: layout accounts for ${off} of ${buf.length} floats`);
	}

	const nComp = meta.layout[0].shape[0];
	const nFlat = meta.layout[1].shape[1];
	return {
		shared, name, nComp, nFlat,
		alpha: parts.alpha,
		pcaComponents: parts.pca_components,
		pcaMean: parts.pca_mean,
		kernelAmplitude: meta.kernel_amplitude,
		kernelMetric: meta.kernel_metric,
		gpMean: meta.gp_mean,
		kernelType: meta.kernel_type,
		floorValue: meta.floor_value,
		outputShape: meta.output_shape,
		quantity: meta.quantity,
		axes: meta.axes,
	};
}

/**
 * log10 of the statistic at `theta`, flat, in `emu.outputShape` order.
 *
 * ~600k multiply-adds for the GP plus one PCA reconstruction: about 1-3 ms,
 * which is what makes dragging a slider feel continuous.
 */
export function predict(emu, theta) {
	const { X, nTrain, nParams, scalerMean, scalerScale } = emu.shared;
	const { nComp, nFlat, alpha, kernelMetric, kernelAmplitude, gpMean } = emu;

	const xs = new Float64Array(nParams);
	for (let p = 0; p < nParams; p++) xs[p] = (theta[p] - scalerMean[p]) / scalerScale[p];

	// Hoisted out of the component loop: the training-point offsets do not
	// depend on the component, only the metric that divides them does.
	const diff = new Float64Array(nTrain * nParams);
	for (let t = 0, o = 0; t < nTrain; t++) {
		for (let p = 0; p < nParams; p++, o++) diff[o] = xs[p] - X[o];
	}

	const w = new Float64Array(nComp);
	for (let i = 0; i < nComp; i++) {
		const met = kernelMetric[i];
		const aOff = i * nTrain;
		let acc = 0;
		for (let t = 0, o = 0; t < nTrain; t++) {
			let r2 = 0;
			for (let p = 0; p < nParams; p++, o++) {
				const d = diff[o];
				r2 += (d * d) / met[p];
			}
			acc += matern(r2, emu.kernelType) * alpha[aOff + t];
		}
		w[i] = gpMean[i] + kernelAmplitude[i] * acc;
	}

	const out = new Float64Array(nFlat);
	for (let i = 0; i < nComp; i++) {
		const wi = w[i], off = i * nFlat;
		for (let j = 0; j < nFlat; j++) out[j] += wi * emu.pcaComponents[off + j];
	}
	const floor = emu.floorValue;
	for (let j = 0; j < nFlat; j++) out[j] += emu.pcaMean[j] + floor;
	return out;
}

/** Indices of parameters that fall outside the training box (empty = all good). */
export function outOfBounds(shared, theta) {
	const bad = [];
	shared.paramRanges.forEach(([lo, hi], i) => {
		if (theta[i] < lo || theta[i] > hi) bad.push(i);
	});
	return bad;
}
