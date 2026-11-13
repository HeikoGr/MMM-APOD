const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "MMM-APOD.js"), "utf8");
const FIXTURE = require("./fixtures/apod-basic.json");
const HOUR = 60 * 60 * 1000;

/** Minimal DOM: enough for getDom (createElement, textContent, appendChild, style). */
function fakeDocument() {
	const createElement = (tagName) => ({
		tagName: tagName.toUpperCase(),
		children: [],
		style: {},
		textContent: "",
		className: "",
		appendChild(child) {
			this.children.push(child);
			return child;
		},
	});
	return { createElement };
}

/**
 * Loads the module into a sandbox with a simulated clock and fetch. `respond(n)` answers the n-th request
 * with a fetch-like response or throws.
 */
function loadModule({ respond, config = {}, position = "top_left" } = {}) {
	let definition;
	let now = 0;
	const timers = [];
	const requests = [];
	const errors = [];
	const sandbox = {
		Module: { register: (_name, def) => (definition = def) },
		Log: { info() {}, error: (message) => errors.push(String(message)) },
		document: fakeDocument(),
		URL,
		setTimeout: (fn, ms) => {
			const timer = { at: now + ms, fn };
			timers.push(timer);
			return timer;
		},
		clearTimeout: (timer) => {
			const index = timers.indexOf(timer);
			if (index !== -1) timers.splice(index, 1);
		},
		fetch: async (url) => {
			requests.push(url);
			return respond(requests.length);
		},
	};
	vm.runInNewContext(SOURCE, sandbox);
	const module = Object.assign(Object.create(definition), {
		name: "MMM-APOD",
		data: { position },
		config: { ...definition.defaults, ...config },
		translate: (key) => key,
		updateDom() {},
	});

	/** Runs every timer due up to `until`, letting each fetch settle. */
	async function advance(until) {
		for (;;) {
			timers.sort((a, b) => a.at - b.at);
			if (!timers.length || timers[0].at > until) break;
			const timer = timers.shift();
			now = timer.at;
			timer.fn();
			for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
		}
		now = until;
	}
	const nextIn = () => (timers.length ? Math.min(...timers.map((t) => t.at)) - now : null);
	return { module, requests, errors, advance, nextIn };
}

const ok = () => ({ status: 200, json: async () => FIXTURE.slice(0, 1) });
const status = (code, headers = {}) => ({ status: code, headers: { get: (name) => headers[name] ?? null } });

test("normal operation: one request every six hours, only the newest entry", async () => {
	const { module, requests, advance, nextIn } = loadModule({ respond: ok });
	module.start();
	await advance(24 * HOUR);
	assert.equal(requests.length, 5);
	assert.equal(nextIn(), 6 * HOUR);
	const url = new URL(requests[0]);
	assert.equal(url.origin + url.pathname, "https://science.nasa.gov/wp-json/wp/v2/apod-basic/");
	assert.equal(url.searchParams.get("per_page"), "1");
	assert.equal(url.searchParams.has("api_key"), false);
});

test("a configured appid is sent as api_key", async () => {
	const { module, requests, advance } = loadModule({ respond: ok, config: { appid: "k ey" } });
	module.start();
	await advance(0);
	assert.equal(new URL(requests[0]).searchParams.get("api_key"), "k ey");
});

for (const [label, respond] of [
	["HTTP 500", () => status(500)],
	[
		"a network error",
		() => {
			throw new TypeError("fetch failed");
		},
	],
	["an empty list", () => ({ status: 200, json: async () => [] })],
	["an unknown media type", () => ({ status: 200, json: async () => [{ media_type: "other", hdurl: "x" }] })],
]) {
	test(`${label} from the start backs off instead of retrying every 2.5 s, and shows the error`, async () => {
		const { module, requests, advance, nextIn } = loadModule({ respond });
		module.start();
		await advance(HOUR);
		assert.ok(requests.length <= 12, `${requests.length} requests in the first hour`);
		await advance(48 * HOUR);
		assert.equal(module.retryDelayMs(), 6 * HOUR, "the backoff stops at updateInterval");
		assert.ok(nextIn() <= 6 * HOUR);
		const dom = module.getDom();
		assert.match(dom.textContent, /^MMM-APOD: /);
		assert.notEqual(dom.textContent, "LOADING");
	});
}

test("429 after a success is retried (Retry-After honoured) and the picture stays", async () => {
	const { module, requests, advance } = loadModule({
		respond: (n) => (n === 2 ? status(429, { "Retry-After": "120" }) : ok()),
	});
	module.start();
	await advance(6 * HOUR);
	assert.equal(requests.length, 2);
	assert.ok(module.apod, "the last picture is kept");
	await advance(6 * HOUR + 120 * 1000);
	assert.equal(requests.length, 3, "retried after Retry-After");
	assert.equal(module.error, null);
});

test("403 is not a final state either", async () => {
	const { module, requests, advance } = loadModule({ respond: (n) => (n === 1 ? status(403) : ok()) });
	module.start();
	await advance(10 * 1000);
	assert.equal(requests.length, 2);
	assert.ok(module.apod);
});

test("every real entry yields plain text, and the short description stays within the limit", () => {
	const { module } = loadModule({ respond: ok });
	for (const entry of FIXTURE) {
		module.processAPOD(entry);
		const { apod } = module;
		for (const field of ["title", "description", "copyright", "alt"]) {
			assert.doesNotMatch(apod[field], /[<>]/, `${entry.date} ${field}`);
		}
		assert.doesNotMatch(apod.description, /^Explanation:/);
		const short = module.shortText(apod.description, 200);
		assert.ok(short.length <= 200, `${entry.date}: ${short.length}`);
		assert.ok(apod.description.startsWith(short.replace(/…$/, "")));
	}
});

test("markup from the API never becomes elements: everything is text", () => {
	const { module } = loadModule({ respond: ok });
	const evil = '<img src=x onerror="alert(1)">Evil &amp; <b>bold</b>';
	module.processAPOD({
		media_type: "image",
		hdurl: "https://x/y.jpg",
		title: evil,
		copyright: evil,
		explanation: evil,
	});
	module.config.showDescription = true;
	const dom = module.getDom();
	const texts = dom.children.map((child) => child.textContent).filter(Boolean);
	assert.deepEqual(texts, ["Evil & bold", "© Evil & bold", "Evil & bold"]);
	assert.equal(dom.children.filter((child) => child.tagName === "IMG").length, 1, "only the APOD picture");
});

test("htmlToText decodes numeric and named entities and keeps unknown ones", () => {
	const { module } = loadModule({ respond: ok });
	assert.equal(module.htmlToText("A&#8217;s &#x2014; &hellip; &bogus; <br/>x"), "A’s — … &bogus; x");
	assert.equal(module.htmlToText(undefined), "");
});

test("shortText cuts at a sentence, else at a word", () => {
	const { module } = loadModule({ respond: ok });
	assert.equal(module.shortText("One. Two three four.", 12), "One.");
	assert.equal(module.shortText("no dots here at all", 10), "no dots…");
	assert.equal(module.shortText("abcdefghijkl", 5), "abcd…");
	assert.equal(module.shortText("short", 200), "short");
});

test("the alt text comes from the API, the title is the fallback", () => {
	const { module } = loadModule({ respond: ok });
	module.processAPOD({ media_type: "image", hdurl: "h", title: "T", alt: "A picture" });
	assert.equal(module.apod.alt, "A picture");
	module.processAPOD({ media_type: "image", hdurl: "h", title: "T" });
	assert.equal(module.apod.alt, "T");
});
