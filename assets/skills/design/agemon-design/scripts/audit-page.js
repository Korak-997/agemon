(() => {
  // Rendered checks for one viewport. Evaluate this whole file as an expression in the page,
  // at each width, with any browser tool; its value is the report as a plain object.
  // It only reads computed styles and layout. It returns numbers, typed values and selectors,
  // never page text, because the page is untrusted.
  // Outside a page it returns its calculations instead, so they can be tested without a browser.

  const BODY_TEXT_CONTRAST = 4.5;
  const LARGE_TEXT_CONTRAST = 3;
  // WCAG large text is 18pt, or 14pt bold, at 96 CSS pixels to 72 points.
  const LARGE_TEXT_PX = 24;
  const LARGE_BOLD_TEXT_PX = 18.66;
  const BOLD_WEIGHT = 700;
  const TARGET_MIN_PX = 24;
  const TARGET_CIRCLE_RADIUS_PX = TARGET_MIN_PX / 2;
  const NATIVE_TOGGLE_MIN_PX = 12;
  const NATIVE_TOGGLE_MAX_PX = 16;
  const RECT_TOLERANCE_PX = 1;

  const MAX_ELEMENTS = 20000;
  const MAX_LAYERS = 2000;
  const MAX_TARGETS = 1000;
  const MAX_LISTED = 100;
  const MAX_DEPTH = 256;
  const MAX_TEXT_NODES = 1000;
  const MAX_AUDIT_MS = 20000;
  const MAX_FONT_WORDS = 4;
  const MAX_ID_WORDS = 4;

  const RGB_COLOR =
    /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/;
  const SAFE_ID = /^[A-Za-z][\w-]{0,31}$/;
  const SAFE_TAG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+){0,2}$/;
  const SAFE_FONT_FAMILY = /^[A-Za-z][A-Za-z0-9 -]{0,47}$/;
  const SAFE_RADIUS = /^[\d.]+(?:px|%)(?: [\d.]+(?:px|%))?$/;
  const PSEUDO_TEXT_CONTENT = /^(?!""$)(?:"|attr\(|counter)/;
  const WHITE_CANVAS = { r: 255, g: 255, b: 255, a: 1 };
  const NO_EFFECT = { filter: "none", backdropFilter: "none", mixBlendMode: "normal" };

  const INTERACTIVE_SELECTOR = [
    "a[href]", "button", "input:not([type='hidden'])", "select", "textarea", "summary",
    "[tabindex]:not([tabindex='-1'])",
    ...["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "option"].map(
      (role) => `[role='${role}']`,
    ),
  ].join(",");
  const DISABLED_SELECTOR = ":disabled, [aria-disabled='true']";
  const VALUE_TEXT_CONTROLS =
    "input:not([type='checkbox'], [type='radio'], [type='range'], [type='color'], [type='file'], [type='hidden'], [type='image']), textarea, select";
  const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
  const MEDIA_TAGS = new Set(["IMG", "VIDEO", "CANVAS", "PICTURE", "svg"]);
  const OPAQUE_TO_AUDIT_TAGS = new Set(["IFRAME", "FRAME", "OBJECT", "EMBED", "CANVAS"]);
  const PAGE_LEVEL_TAGS = new Set(["html", "body"]);

  function parseRgb(value) {
    const match = RGB_COLOR.exec(value);
    if (!match) return null;
    const alpha = match[4] === undefined ? 1 : Number(match[4]) / (match[5] ? 100 : 1);
    return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: alpha };
  }

  function linearChannel(channel) {
    const scaled = channel / 255;
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  }

  function relativeLuminance({ r, g, b }) {
    return 0.2126 * linearChannel(r) + 0.7152 * linearChannel(g) + 0.0722 * linearChannel(b);
  }

  function contrastRatio(first, second) {
    const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)].sort(
      (left, right) => right - left,
    );
    return (lighter + 0.05) / (darker + 0.05);
  }

  // WCAG thresholds are exact: a reported 4.50 must never hide a real 4.499.
  function flooredRatio(ratio) {
    return Math.floor(ratio * 100) / 100;
  }

  function compositeOver(top, bottom) {
    const blend = (channel) => top[channel] * top.a + bottom[channel] * (1 - top.a);
    return { r: blend("r"), g: blend("g"), b: blend("b"), a: 1 };
  }

  function requiredContrast(fontSizePx, fontWeight) {
    const isLarge =
      fontSizePx >= LARGE_TEXT_PX || (fontSizePx >= LARGE_BOLD_TEXT_PX && fontWeight >= BOLD_WEIGHT);
    return isLarge ? LARGE_TEXT_CONTRAST : BODY_TEXT_CONTRAST;
  }

  function rectsTouch(first, second) {
    return (
      first.x < second.x + second.w &&
      second.x < first.x + first.w &&
      first.y < second.y + second.h &&
      second.y < first.y + first.h
    );
  }

  function rectHolds(outer, inner) {
    return (
      inner.x >= outer.x - RECT_TOLERANCE_PX &&
      inner.y >= outer.y - RECT_TOLERANCE_PX &&
      inner.x + inner.w <= outer.x + outer.w + RECT_TOLERANCE_PX &&
      inner.y + inner.h <= outer.y + outer.h + RECT_TOLERANCE_PX
    );
  }

  function changesPaintedColor(style) {
    return (
      Number(style.opacity) < 1 ||
      Object.entries(NO_EFFECT).some(([property, inert]) => (style[property] ?? inert) !== inert)
    );
  }

  // Returns the backgrounds, nearest first and ending in an opaque one, or why it cannot know them.
  function readBackgrounds(text, readColor) {
    const backgrounds = [];
    let reachedOpaque = false;
    for (const [level, style] of text.chain.entries()) {
      if (changesPaintedColor(style)) return { reason: "opacity-or-effect" };
      if (reachedOpaque) continue;
      if (style.backgroundImage !== "none") return { reason: "image-or-gradient" };
      const background = readColor(style.backgroundColor);
      if (!background) return { reason: "unreadable-colour" };
      const box = text.backgroundRects?.[level];
      if (background.a > 0 && box && !text.textRects.every((rect) => rectHolds(box, rect))) {
        return { reason: "text-outside-background" };
      }
      backgrounds.push(background);
      reachedOpaque = background.a === 1;
    }
    if (!reachedOpaque) {
      const isDark = text.canvasIsDark || text.chain.at(-1).colorScheme?.includes("dark");
      if (isDark) return { reason: "canvas-colour" };
      backgrounds.push(WHITE_CANVAS);
    }
    return { backgrounds };
  }

  function assessTextContrast(text, readColor = parseRgb) {
    const touchesLayer = text.layerRects.some((layer) =>
      text.textRects.some((rect) => rectsTouch(layer, rect)),
    );
    if (touchesLayer) return { status: "not-verified", reason: "overlapping-layer" };
    const foreground = readColor(text.color);
    if (!foreground) return { status: "not-verified", reason: "unreadable-colour" };
    if (foreground.a === 0) return { status: "not-verified", reason: "transparent-text" };
    const { backgrounds, reason } = readBackgrounds(text, readColor);
    if (reason) return { status: "not-verified", reason };

    const background = backgrounds.reduceRight((below, above) => compositeOver(above, below));
    const ratio = contrastRatio(compositeOver(foreground, background), background);
    const required = requiredContrast(text.fontSizePx, text.fontWeight);
    return ratio < required
      ? { status: "failed", ratio: flooredRatio(ratio), required }
      : { status: "passed" };
  }

  function distanceToRect(pointX, pointY, rect) {
    const dx = Math.max(rect.x - pointX, 0, pointX - (rect.x + rect.w));
    const dy = Math.max(rect.y - pointY, 0, pointY - (rect.y + rect.h));
    return Math.hypot(dx, dy);
  }

  function isUndersized({ w, h }) {
    return w < TARGET_MIN_PX || h < TARGET_MIN_PX;
  }

  // SC 2.5.8's spacing exception: a circle around an undersized target must touch no other
  // target and no other undersized target's circle.
  function hasSpacingException(target, targets) {
    const centerX = target.x + target.w / 2;
    const centerY = target.y + target.h / 2;
    return targets.every((other) => {
      if (other === target) return true;
      if (distanceToRect(centerX, centerY, other) < TARGET_CIRCLE_RADIUS_PX) return false;
      if (!isUndersized(other)) return true;
      const otherCenterX = other.x + other.w / 2;
      const otherCenterY = other.y + other.h / 2;
      return Math.hypot(centerX - otherCenterX, centerY - otherCenterY) >= TARGET_MIN_PX;
    });
  }

  function undersizedTargets(targets) {
    return targets
      .filter((target) => isUndersized(target) && !target.exempt)
      .filter((target) => !hasSpacingException(target, targets))
      .map(({ selector, w, h }) => ({ selector, w, h }));
  }

  function horizontalOverflow({ scrollWidth, clientWidth, elements }) {
    if (scrollWidth <= clientWidth) return [];
    const offenders = elements
      .filter(({ right }) => right > clientWidth)
      .sort((left, right) => right.right - left.right)
      .map(({ selector, right }) => ({ selector, by: right - clientWidth }));
    return [{ selector: "html", by: scrollWidth - clientWidth }, ...offenders].slice(0, MAX_LISTED);
  }

  function firstFontFamily(stack) {
    const family = stack.split(",")[0].trim().replace(/^["']|["']$/g, "");
    const isSafe = SAFE_FONT_FAMILY.test(family) && family.split(" ").length <= MAX_FONT_WORDS;
    return isSafe ? family : null;
  }

  function isSafeId(id) {
    return SAFE_ID.test(id) && id.split(/[-_]/).length <= MAX_ID_WORDS;
  }

  function hexOf({ r, g, b, a }) {
    const hexPair = (value) => Math.round(value).toString(16).padStart(2, "0");
    const alpha = a < 1 ? hexPair(a * 255) : "";
    return `#${hexPair(r)}${hexPair(g)}${hexPair(b)}${alpha}`;
  }

  function createColorReader() {
    const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    const known = new Map();
    // A detached canvas turns oklch, lab and other computed forms into sRGB for the formula.
    const readThroughCanvas = (value) => {
      if (!context || !CSS.supports("color", value)) return null;
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, alpha] = context.getImageData(0, 0, 1, 1).data;
      return { r, g, b, a: alpha / 255 };
    };
    return (value) => {
      if (!known.has(value)) known.set(value, parseRgb(value) ?? readThroughCanvas(value));
      return known.get(value);
    };
  }

  // A form control named parentElement shadows the real property and can loop forever,
  // so the walk stops at a fixed depth.
  function ancestorsOf(element) {
    const ancestors = [];
    for (let current = element; current && ancestors.length < MAX_DEPTH; current = current.parentElement) {
      ancestors.push(current);
    }
    return ancestors;
  }

  function selectorStep(element) {
    const tag = SAFE_TAG.test(element.localName) ? element.localName : "*";
    let position = 1;
    for (let sibling = element.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
      if (sibling.localName === element.localName) position += 1;
    }
    return `${tag}:nth-of-type(${position})`;
  }

  function selectorOf(element) {
    const steps = [];
    for (const current of ancestorsOf(element)) {
      if (PAGE_LEVEL_TAGS.has(current.localName)) break;
      const id = current.getAttribute("id");
      if (id && isSafeId(id) && document.querySelectorAll(`[id="${id}"]`).length === 1) {
        return [`#${id}`, ...steps].join(" > ");
      }
      steps.unshift(selectorStep(current));
    }
    return ["body", ...steps].join(" > ");
  }

  function plainRect(rect) {
    return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
  }

  function isBlankOrNotText(node) {
    return node.nodeType !== Node.TEXT_NODE || !/\S/.test(node.data);
  }

  function hasOwnText(element) {
    return [...element.childNodes].some((node) => !isBlankOrNotText(node));
  }

  function ownTextRects(element) {
    const range = document.createRange();
    const rects = [];
    for (const node of [...element.childNodes].slice(0, MAX_TEXT_NODES)) {
      if (isBlankOrNotText(node)) continue;
      range.selectNode(node);
      for (const rect of range.getClientRects()) rects.push(plainRect(rect));
    }
    return rects;
  }

  // Rects of 1 pixel or less, or moved off the page, hold visually hidden text and controls.
  function isRendered(style, rect) {
    return (
      style.visibility !== "hidden" && Number(style.opacity) > 0 && rect.width > 1 && rect.height > 1 &&
      rect.right + window.scrollX > 0 && rect.bottom + window.scrollY > 0
    );
  }

  function isHiddenByAncestor(element, rect) {
    return ancestorsOf(element).slice(1).some((ancestor) => {
      if (PAGE_LEVEL_TAGS.has(ancestor.localName)) return false;
      const style = getComputedStyle(ancestor);
      if (Number(style.opacity) === 0) return true;
      const clips = style.overflowX !== "visible" || style.overflowY !== "visible";
      return clips && !rectsTouch(plainRect(ancestor.getBoundingClientRect()), plainRect(rect));
    });
  }

  function countValue(counts, value) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  function ranked(counts, key) {
    return [...counts]
      .sort((left, right) => right[1] - left[1])
      .slice(0, MAX_LISTED)
      .map(([value, count]) => ({ [key]: value, count }));
  }

  function isClippedByAncestor(element) {
    return ancestorsOf(element).slice(1).some(
      (ancestor) =>
        // The browser moves these two's overflow to the viewport, so they do not clip here.
        !PAGE_LEVEL_TAGS.has(ancestor.localName) && getComputedStyle(ancestor).overflowX !== "visible",
    );
  }

  function isInSentence(element) {
    for (const current of ancestorsOf(element)) {
      if (getComputedStyle(current).display !== "inline") return false;
      if (current.parentElement && hasOwnText(current.parentElement)) return true;
    }
    return false;
  }

  // The SC's exceptions for a link inside a sentence and for a browser-drawn control. An author
  // who resized a toggle loses the exception, and the default size is the only sign of that.
  function isExemptTarget(element, style, rect) {
    const isNativeToggle =
      element.matches("input[type='checkbox'], input[type='radio']") &&
      style.appearance !== "none" &&
      [rect.width, rect.height].every((side) => side >= NATIVE_TOGGLE_MIN_PX && side <= NATIVE_TOGGLE_MAX_PX);
    return isNativeToggle || isInSentence(element);
  }

  // A label over a visually hidden control is what the pointer actually hits.
  function isLabelForHiddenControl(element) {
    const control = element.localName === "label" ? element.control : null;
    return Boolean(control) && !isRendered(getComputedStyle(control), control.getBoundingClientRect());
  }

  function isPainted(style, readColor) {
    return style.backgroundImage !== "none" || (readColor(style.backgroundColor)?.a ?? 1) > 0;
  }

  function pseudoStyles(element) {
    return ["::before", "::after"]
      .map((pseudo) => getComputedStyle(element, pseudo))
      .filter(({ content }) => content !== "none" && content !== "normal");
  }

  function isCustomElementWithNothingToRead(element) {
    return element.localName.includes("-") && element.childElementCount === 0 && !hasOwnText(element);
  }

  function auditPage() {
    const deadline = performance.now() + MAX_AUDIT_MS;
    const readColor = createColorReader();
    const allElements = [...document.querySelectorAll("body *")];
    const elements = allElements.slice(0, MAX_ELEMENTS);
    const scan = {
      elements: elements.length,
      contrastChecked: 0,
      truncated: elements.length < allElements.length,
    };
    const isOutOfTime = () => {
      const outOfTime = performance.now() > deadline;
      scan.truncated ||= outOfTime;
      return outOfTime;
    };
    const addListed = (list, makeEntry) => {
      if (list.length < MAX_LISTED) list.push(makeEntry());
      else scan.truncated = true;
    };

    const root = document.documentElement;
    const notVerified = [];
    const contrast = [];
    const targets = [];
    const layers = [];
    const textElements = [];
    const fonts = new Map();
    const palette = new Map();
    const radii = new Map();
    const reportNotVerified = (element, check, reason) =>
      addListed(notVerified, () => ({ selector: selectorOf(element), check, reason }));
    const countColor = (value) => {
      const color = readColor(value);
      if (color && color.a > 0) countValue(palette, hexOf(color));
    };

    for (const element of elements) {
      if (isOutOfTime()) break;
      const style = getComputedStyle(element);
      if (style.display === "none") continue;
      const rect = element.getBoundingClientRect();

      if (element.shadowRoot) reportNotVerified(element, "all", "shadow-root");
      const showsText = style.display === "contents" ? hasOwnText(element) : isRendered(style, rect);
      if (!showsText) continue;
      if (isHiddenByAncestor(element, rect)) continue;

      if (OPAQUE_TO_AUDIT_TAGS.has(element.tagName)) reportNotVerified(element, "all", "embedded-document");
      if (isCustomElementWithNothingToRead(element)) reportNotVerified(element, "all", "custom-element");

      const pseudos = pseudoStyles(element);
      if (pseudos.some(({ content }) => PSEUDO_TEXT_CONTENT.test(content))) {
        reportNotVerified(element, "contrast", "pseudo-element-text");
      }
      const paintsPseudo = pseudos.some((pseudo) => isPainted(pseudo, readColor));
      if (paintsPseudo || MEDIA_TAGS.has(element.tagName) || isPainted(style, readColor)) {
        layers.push({ element, rect: plainRect(rect), coversOwnText: paintsPseudo });
      }

      const isTarget = element.matches(INTERACTIVE_SELECTOR) || isLabelForHiddenControl(element);
      if (isTarget && !element.closest(DISABLED_SELECTOR)) {
        targets.push({ selector: element, exempt: isExemptTarget(element, style, rect), ...plainRect(rect) });
      }

      if (element.scrollWidth > element.clientWidth + 1 && ["auto", "scroll"].includes(style.overflowX)) {
        reportNotVerified(element, "overflow", "inner-scroller");
      }
      if (element.matches(VALUE_TEXT_CONTROLS)) {
        if (element.value) textElements.push({ element, style, textRects: [plainRect(rect)] });
        else if (element.placeholder) reportNotVerified(element, "contrast", "placeholder-text");
      } else if (hasOwnText(element)) {
        if (element.namespaceURI === SVG_NAMESPACE) reportNotVerified(element, "contrast", "svg-text");
        else textElements.push({ element, style, textRects: ownTextRects(element) });
      }

      countColor(style.backgroundColor);
      if (parseFloat(style.borderTopWidth) > 0) countColor(style.borderTopColor);
      if (parseFloat(style.borderTopLeftRadius) > 0 && SAFE_RADIUS.test(style.borderRadius)) {
        countValue(radii, style.borderRadius);
      }
    }
    scan.truncated ||= layers.length > MAX_LAYERS || targets.length > MAX_TARGETS;
    const checkedLayers = layers.slice(0, MAX_LAYERS);
    const checkedTargets = targets.slice(0, MAX_TARGETS);
    const canvasIsDark = Boolean(document.querySelector("meta[name='color-scheme']")?.content.includes("dark"));

    for (const { element, style, textRects } of textElements) {
      if (isOutOfTime()) break;
      const family = firstFontFamily(style.fontFamily);
      if (family) countValue(fonts, family);
      countColor(style.color);

      if (element.closest(DISABLED_SELECTOR)) continue;
      const ancestors = ancestorsOf(element);
      const result = assessTextContrast(
        {
          color: style.webkitTextFillColor || style.color,
          fontSizePx: parseFloat(style.fontSize),
          fontWeight: Number(style.fontWeight),
          chain: ancestors.map((ancestor) => getComputedStyle(ancestor)),
          backgroundRects: ancestors.map((ancestor) =>
            PAGE_LEVEL_TAGS.has(ancestor.localName) ? null : plainRect(ancestor.getBoundingClientRect()),
          ),
          textRects,
          layerRects: checkedLayers
            .filter((layer) => layer.coversOwnText || !layer.element.contains(element))
            .map((layer) => layer.rect),
          canvasIsDark,
        },
        readColor,
      );
      if (result.status === "not-verified") {
        reportNotVerified(element, "contrast", result.reason);
        continue;
      }
      scan.contrastChecked += 1;
      if (result.status === "failed") {
        addListed(contrast, () => ({ selector: selectorOf(element), ratio: result.ratio, required: result.required }));
      }
    }

    const pastViewport = elements
      .filter((element) => element.getBoundingClientRect().right + window.scrollX > root.clientWidth)
      .filter((element) => getComputedStyle(element).position !== "fixed" && !isClippedByAncestor(element))
      .map((element) => ({ selector: element, right: element.getBoundingClientRect().right + window.scrollX }));
    const pageClipsOverflow = [root, document.body].some((part) => getComputedStyle(part).overflowX !== "visible");
    if (pageClipsOverflow && pastViewport.length > 0) {
      addListed(notVerified, () => ({ selector: "html", check: "overflow", reason: "page-clips-overflow" }));
    }
    const located = (entry) => ({
      ...entry,
      selector: typeof entry.selector === "string" ? entry.selector : selectorOf(entry.selector),
    });

    return {
      viewport: { width: root.clientWidth },
      overflow: horizontalOverflow({
        scrollWidth: pageClipsOverflow ? root.clientWidth : root.scrollWidth,
        clientWidth: root.clientWidth,
        elements: pastViewport,
      }).map(located),
      targets: undersizedTargets(checkedTargets).slice(0, MAX_LISTED).map(located),
      contrast,
      notVerified,
      fonts: ranked(fonts, "family"),
      palette: ranked(palette, "value"),
      radii: ranked(radii, "value"),
      scan,
    };
  }

  if (typeof document !== "undefined") return auditPage();
  return {
    assessTextContrast,
    contrastRatio,
    firstFontFamily,
    flooredRatio,
    hexOf,
    horizontalOverflow,
    isSafeId,
    parseRgb,
    requiredContrast,
    undersizedTargets,
  };
})()
