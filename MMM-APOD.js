/* MagicMirror²
 * Module: MMM-APOD
 *
 * MagicMirror² By Michael Teeuw https://magicmirror.builders
 * MIT Licensed.
 *
 * Module MMM-APOD By Grena https://github.com/grenagit
 * MIT Licensed.
 */

Module.register("MMM-APOD", {
	// Default module config
	defaults: {
		appid: "", // optional: NASA's current APOD API needs no key; sent as api_key when set
		updateInterval: 6 * 60 * 60 * 1000, // every 6 hours
		animationSpeed: 1000, // 1 second
		maxMediaWidth: 0,
		maxMediaHeight: 0,
		maxDescriptionLength: 200,
		backgroundSize: "cover",
		backgroundPosition: "center",
		backgroundOverlay:
			"linear-gradient(to bottom, rgba(0, 0, 0, 0.75) 0%, rgba(0, 0, 0, 0) 40%, rgba(0, 0, 0, 0) 80%, rgba(0, 0, 0, 0.75) 100%)",
		showTitle: true,
		showDescription: false,
		useShortDescription: true,

		initialLoadDelay: 0, // 0 seconds delay
		retryDelay: 2500, // first retry after 2.5 seconds, doubling up to updateInterval

		apiBase: "https://science.nasa.gov/wp-json/wp/v2/",
		apodEndpoint: "apod-basic/",
	},

	getStyles: () => ["MMM-APOD.css"],

	start: function () {
		Log.info(`Starting module: ${this.name}`);

		this.apod = null; // { title, description, copyright, alt, type, url }
		this.error = null;
		this.failures = 0;
		this.backgrounded = this.data.position === "fullscreen_below";
		if (this.backgrounded) this.data.header = null;

		this.scheduleUpdate(this.config.initialLoadDelay);
	},

	getDom: function () {
		const wrapper = document.createElement("div");

		if (!this.apod) {
			// Before the first picture: say why there is none instead of "Loading…" forever.
			wrapper.textContent = this.error ? `${this.name}: ${this.error}` : this.translate("LOADING");
			wrapper.className = "dimmed light small";
			return wrapper;
		}

		const { apod } = this;
		if (this.backgrounded) {
			const background = document.createElement("div");
			background.className = "background";
			background.style.backgroundSize = this.config.backgroundSize;
			background.style.backgroundPosition = this.config.backgroundPosition;
			background.style.backgroundImage = `url("${encodeURI(apod.url)}")`;
			wrapper.appendChild(background);

			if (this.config.backgroundOverlay) {
				const overlay = document.createElement("div");
				overlay.className = "overlay";
				overlay.style.background = this.config.backgroundOverlay;
				wrapper.appendChild(overlay);
			}
			return wrapper;
		}

		if (this.config.showTitle) {
			wrapper.appendChild(this.textDiv("dimmed light small", apod.title));
		}

		const image = document.createElement("img");
		if (Number(this.config.maxMediaWidth) !== 0) image.style.maxWidth = `${this.config.maxMediaWidth}px`;
		if (Number(this.config.maxMediaHeight) !== 0) image.style.maxHeight = `${this.config.maxMediaHeight}px`;
		image.src = apod.url;
		image.alt = apod.alt;
		wrapper.appendChild(image);

		// The API leaves copyright out (or empty) for public-domain pictures.
		if (apod.copyright) {
			wrapper.appendChild(this.textDiv("dimmed thin xsmall", `© ${apod.copyright}`));
		}

		if (this.config.showDescription && apod.description) {
			const text = this.config.useShortDescription
				? this.shortText(apod.description, this.config.maxDescriptionLength)
				: apod.description;
			const description = this.textDiv("dimmed light xsmall description", text);
			if (Number(this.config.maxMediaWidth) !== 0) {
				description.style.maxWidth = `${this.config.maxMediaWidth}px`;
			} else if (apod.type === "video") {
				description.style.maxWidth = "960px";
			}
			wrapper.appendChild(description);
		}

		return wrapper;
	},

	textDiv: (className, text) => {
		const div = document.createElement("div");
		div.className = className;
		div.textContent = text;
		return div;
	},

	/** The request URL: only the newest entry (per_page=1), the key only when one is configured. */
	buildUrl: function () {
		const url = new URL(this.config.apodEndpoint, this.config.apiBase);
		url.searchParams.set("per_page", "1");
		if (this.config.appid) url.searchParams.set("api_key", this.config.appid);
		return url.toString();
	},

	updateAPOD: async function () {
		let retryAfterMs = null;
		try {
			const response = await fetch(this.buildUrl());
			if (response.status !== 200) {
				if (response.status === 429 || response.status === 403) {
					const seconds = Number(response.headers?.get?.("Retry-After"));
					if (Number.isFinite(seconds) && seconds > 0) retryAfterMs = seconds * 1000;
				}
				const reason = {
					403: `access denied by NASA${this.config.appid ? " (check appid)" : ""}`,
					429: "rate limit exceeded",
				};
				throw new Error(reason[response.status] ?? `could not load APOD (HTTP ${response.status})`);
			}
			const result = await response.json();
			this.processAPOD(Array.isArray(result) ? result[0] : result);
			this.failures = 0;
			this.error = null;
			this.scheduleUpdate(this.config.updateInterval);
		} catch (error) {
			this.failures += 1;
			this.error = error?.message || String(error);
			Log.error(`${this.name}: ${this.error}`);
			// Keep the last picture; before the first one show the error.
			if (!this.apod) this.updateDom(this.config.animationSpeed);
			this.scheduleUpdate(retryAfterMs ?? this.retryDelayMs());
		}
	},

	/** Exponential backoff from retryDelay, capped at updateInterval: 2.5 s, 5 s, 10 s, … 6 h. */
	retryDelayMs: function () {
		const base = Math.max(1000, Number(this.config.retryDelay) || 0);
		return Math.min(base * 2 ** (this.failures - 1), this.config.updateInterval);
	},

	/** Takes one API entry; throws when it holds no usable picture (so the caller backs off). */
	processAPOD: function (data) {
		if (!data) throw new Error("NASA returned no APOD entry");
		/*
		 * The new NASA APOD API uses data.url for the APOD article permalink; the featured image
		 * (also on video days, rendered as a still) is data.hdurl.
		 */
		if (!["image", "video", "iframe"].includes(data.media_type)) {
			throw new Error(`unknown APOD media type: ${data.media_type}`);
		}
		if (!data.hdurl) throw new Error("NASA did not provide a usable APOD image");

		const title = this.htmlToText(data.title);
		this.apod = {
			title,
			description: this.htmlToText(data.explanation).replace(/^Explanation:\s*/i, ""),
			copyright: this.htmlToText(data.copyright),
			alt: this.htmlToText(data.alt) || title,
			type: data.media_type,
			url: data.hdurl,
		};
		this.updateDom(this.config.animationSpeed);
	},

	/**
	 * Plain text from the API's HTML fields (title, copyright, explanation): tags removed, entities decoded.
	 * The result only ever goes into textContent, so it is never interpreted as markup.
	 */
	htmlToText: (html) => {
		const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", ndash: "–", mdash: "—" };
		return String(html ?? "")
			.replace(/<br\s*\/?>/gi, " ")
			.replace(/<[^>]*>/g, "")
			.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
				if (entity[0] !== "#") return named[entity.toLowerCase()] ?? match;
				const hex = entity[1].toLowerCase() === "x";
				const code = hex ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
				return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
			})
			.replace(/\s+/g, " ")
			.trim();
	},

	scheduleUpdate: function (delay) {
		const nextLoad = Number.isFinite(delay) && delay >= 0 ? delay : this.config.updateInterval;
		clearTimeout(this.updateTimer);
		this.updateTimer = setTimeout(() => this.updateAPOD(), nextLoad);
	},

	/** Plain text shortened to maxLength without cutting sentences or words. */
	shortText: (text, maxLength) => {
		const value = String(text ?? "");
		if (value.length <= maxLength) return value;
		const sentenceEnd = value.lastIndexOf(". ", maxLength - 1);
		if (sentenceEnd > 0) return value.substring(0, sentenceEnd + 1);
		const wordEnd = value.lastIndexOf(" ", maxLength - 1);
		if (wordEnd > 0) return `${value.substring(0, wordEnd)}…`;
		return `${value.substring(0, maxLength - 1)}…`;
	},
});
