(() => {
  // Evaluated in the built page after audit-page.js, for what that script does not report:
  // shadows, a layout sketch and the dated tells of the skill's tells-2026-11.md.
  // The tells are coarse heuristics, so they count how often a look appears; they do not judge it.
  // Outside a page it returns its calculations, so they can be tested without a browser.

  const MAX_ELEMENTS = 5000;
  const MAX_LISTED = 50;
  const MAX_SKETCH_DEPTH = 8;
  const LAYOUT_COLUMNS = 12;
  const MIN_BLOCK_HEIGHT_PX = 24;
  const MIN_BLOCK_WIDTH_SHARE = 0.05;
  const SAME_ROW_TOLERANCE_PX = 8;

  const DARK_PAGE_LUMINANCE = 0.03;
  const CREAM_MIN_CHANNEL = 225;
  const CREAM_MIN_WARMTH = 4;
  const CREAM_MAX_WARMTH = 45;
  const TINTED_BLACK_MAX_CHANNEL = 45;
  const TINTED_BLACK_MIN_CHROMA = 3;
  const SATURATED_MIN_CHROMA = 80;
  const HUE_BUCKET_DEGREES = 30;
  const NEUTRAL_MAX_CHROMA = 24;

  const MIN_CARD_GROUP = 3;
  const MIN_HAIRLINES = 5;
  const HAIRLINE_MAX_PX = 1;
  const MIN_LABELS_ABOVE_HEADINGS = 2;
  const MIN_MONO_LABELS = 3;
  const MONO_LABEL_MAX_PX = 14;
  // A three-step section is a real sequence, so only markers beyond it count.
  const MIN_NUMBERED_MARKERS = 4;
  const MIN_GRADIENT_WASHES = 2;
  const BIG_NUMBER_MIN_PX = 64;
  const DENSE_MIN_COLUMNS = 3;
  const FOLD_PX = 900;

  const SERIF_STACK = /(?:^|,)\s*["']?(?:[\w -]*\bserif)["']?\s*$/i;
  const SANS_SERIF_STACK = /sans-serif["']?\s*$/i;
  const MONO_STACK = /mono|courier|consolas|menlo/i;
  const SEPARATOR_STRING = /\S\s·\s\S|^[A-Z]{2,}\s[—–]\s\S/;
  const TRAILING_ARROW = /[→↗➜⟶]\s*$/;
  const NUMBERED_MARKER = /^\(?0?\d{1,2}[.)]?$/;
  const BIG_NUMBER = /^[$€£]?[\d.,]+[%+kKmM]*$/;

  function relativeLuminance({ r, g, b }) {
    const linear = (channel) => {
      const scaled = channel / 255;
      return scaled <= 0.04045
        ? scaled / 12.92
        : ((scaled + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  }

  function chromaOf({ r, g, b }) {
    return Math.max(r, g, b) - Math.min(r, g, b);
  }

  function hueOf({ r, g, b }) {
    const chroma = chromaOf({ r, g, b });
    if (chroma === 0) return 0;
    const max = Math.max(r, g, b);
    const sector =
      max === r
        ? ((g - b) / chroma + 6) % 6
        : max === g
          ? (b - r) / chroma + 2
          : (r - g) / chroma + 4;
    return sector * 60;
  }

  function isCream(color) {
    const warmth = color.r - color.b;
    return (
      Math.min(color.r, color.g, color.b) >= CREAM_MIN_CHANNEL &&
      warmth >= CREAM_MIN_WARMTH &&
      warmth <= CREAM_MAX_WARMTH
    );
  }

  function isTintedBlack(color) {
    return (
      Math.max(color.r, color.g, color.b) <= TINTED_BLACK_MAX_CHANNEL &&
      chromaOf(color) >= TINTED_BLACK_MIN_CHROMA
    );
  }

  function detectTells(facts) {
    const isDarkPage =
      relativeLuminance(facts.pageBackground) < DARK_PAGE_LUMINANCE;
    return {
      creamSerifClay: isCream(facts.pageBackground) && facts.headingIsSerif,
      nearBlackOneAccent: isDarkPage && facts.saturatedHues === 1,
      broadsheet:
        facts.hairlines >= MIN_HAIRLINES &&
        facts.denseColumns >= 1 &&
        facts.distinctRadii === 0,
      saasCardKit:
        facts.identicalShadowedCards >= MIN_CARD_GROUP ||
        (facts.identicalCards >= MIN_CARD_GROUP && facts.distinctRadii === 1),
      trackedLabels: facts.labelsAboveHeadings >= MIN_LABELS_ABOVE_HEADINGS,
      separatorStrings: facts.separatorStrings >= 1,
      tintedBlack:
        isTintedBlack(facts.textColor) || isTintedBlack(facts.pageBackground),
      monoLabels: facts.monoLabels >= MIN_MONO_LABELS,
      arrowLinks: facts.arrowLinks >= 1,
      numberedMarkers: facts.numberedMarkers >= MIN_NUMBERED_MARKERS,
      headlineEmphasis: facts.headlineEmphasis >= 1,
      bigNumberHero: facts.bigNumberHero,
      gradientWashes: facts.gradientWashes >= MIN_GRADIENT_WASHES,
    };
  }

  function paletteFamilyOf(color) {
    if (chromaOf(color) <= NEUTRAL_MAX_CHROMA) {
      return relativeLuminance(color) < DARK_PAGE_LUMINANCE
        ? "neutral-dark"
        : "neutral-light";
    }
    return `hue-${Math.floor(hueOf(color) / HUE_BUCKET_DEGREES) * HUE_BUCKET_DEGREES}`;
  }

  function createColorReader() {
    const context = document
      .createElement("canvas")
      .getContext("2d", { willReadFrequently: true });
    const known = new Map();
    return (value) => {
      if (!known.has(value)) {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = "rgba(0, 0, 0, 0)";
        context.fillStyle = value;
        context.fillRect(0, 0, 1, 1);
        const [r, g, b, alpha] = context.getImageData(0, 0, 1, 1).data;
        known.set(value, { r, g, b, a: alpha / 255 });
      }
      return known.get(value);
    };
  }

  function isVisible(element, style) {
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number(style.opacity) === 0
    )
      return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  }

  function ownText(element) {
    return [...element.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.data)
      .join("")
      .trim();
  }

  function columnSpan(rect, pageWidth) {
    const toColumn = (x) =>
      Math.max(
        0,
        Math.min(LAYOUT_COLUMNS, Math.round((x / pageWidth) * LAYOUT_COLUMNS)),
      );
    return `${toColumn(rect.left)}-${toColumn(rect.right)}`;
  }

  function layoutBlocks(element, pageWidth) {
    return [...element.children].filter((child) => {
      const rect = child.getBoundingClientRect();
      const style = getComputedStyle(child);
      return (
        isVisible(child, style) &&
        style.display !== "inline" &&
        rect.height >= MIN_BLOCK_HEIGHT_PX &&
        rect.width >= pageWidth * MIN_BLOCK_WIDTH_SHARE
      );
    });
  }

  // A row of side-by-side blocks ends the descent: its span pattern is the layout decision.
  function sketchLayout(element, pageWidth, depth, tokens) {
    const blocks = layoutBlocks(element, pageWidth);
    if (blocks.length === 0 || depth >= MAX_SKETCH_DEPTH) {
      tokens.push(columnSpan(element.getBoundingClientRect(), pageWidth));
      return;
    }
    const tops = blocks.map((block) => block.getBoundingClientRect().top);
    const isRow =
      blocks.length > 1 &&
      Math.max(...tops) - Math.min(...tops) <= SAME_ROW_TOLERANCE_PX;
    if (isRow) {
      tokens.push(
        blocks
          .map((block) => columnSpan(block.getBoundingClientRect(), pageWidth))
          .join(","),
      );
      return;
    }
    for (const block of blocks)
      sketchLayout(block, pageWidth, depth + 1, tokens);
  }

  function isCardLike(style, readColor) {
    const hasEdge =
      style.boxShadow !== "none" || parseFloat(style.borderTopWidth) > 0;
    return (
      parseFloat(style.borderTopLeftRadius) > 0 &&
      (hasEdge || readColor(style.backgroundColor).a > 0)
    );
  }

  function countIdenticalCards(elements, readColor) {
    let identicalCards = 0;
    let identicalShadowedCards = 0;
    for (const parent of new Set(
      elements.map((element) => element.parentElement),
    )) {
      if (!parent) continue;
      const groups = new Map();
      for (const child of parent.children) {
        const style = getComputedStyle(child);
        if (!isVisible(child, style) || !isCardLike(style, readColor)) continue;
        const key = [
          style.borderRadius,
          style.boxShadow,
          style.backgroundColor,
        ].join("|");
        groups.set(key, {
          count: (groups.get(key)?.count ?? 0) + 1,
          shadowed: style.boxShadow !== "none",
        });
      }
      for (const { count, shadowed } of groups.values()) {
        identicalCards = Math.max(identicalCards, count);
        if (shadowed)
          identicalShadowedCards = Math.max(identicalShadowedCards, count);
      }
    }
    return { identicalCards, identicalShadowedCards };
  }

  function isTrackedLabelStyle(style) {
    return (
      style.textTransform === "uppercase" && parseFloat(style.letterSpacing) > 0
    );
  }

  function hasHeadlineEmphasis(heading, headingStyle, readColor) {
    return [...heading.children].some((child) => {
      const words = child.textContent.trim().split(/\s+/).filter(Boolean);
      if (words.length !== 1) return false;
      const style = getComputedStyle(child);
      const baseColor = readColor(headingStyle.color);
      const color = readColor(style.color);
      return (
        style.fontStyle !== headingStyle.fontStyle ||
        style.fontWeight !== headingStyle.fontWeight ||
        style.backgroundClip === "text" ||
        color.r !== baseColor.r ||
        color.g !== baseColor.g ||
        color.b !== baseColor.b
      );
    });
  }

  function isSerifStack(stack) {
    return SERIF_STACK.test(stack) && !SANS_SERIF_STACK.test(stack);
  }

  function ranked(counts) {
    return [...counts]
      .sort((left, right) => right[1] - left[1])
      .slice(0, MAX_LISTED)
      .map(([value, count]) => ({ value, count }));
  }

  function pageBackgroundOf(readColor) {
    for (const element of [document.body, document.documentElement]) {
      const color = readColor(getComputedStyle(element).backgroundColor);
      if (color.a > 0) return color;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  }

  function fingerprintPage() {
    const readColor = createColorReader();
    const elements = [...document.querySelectorAll("body *")].slice(
      0,
      MAX_ELEMENTS,
    );
    const pageWidth = document.documentElement.clientWidth;
    const shadows = new Map();
    const radii = new Set();
    const saturatedHues = new Set();
    const facts = {
      pageBackground: pageBackgroundOf(readColor),
      textColor: readColor(getComputedStyle(document.body).color),
      headingIsSerif: false,
      saturatedHues: 0,
      hairlines: 0,
      denseColumns: 0,
      distinctRadii: 0,
      labelsAboveHeadings: 0,
      separatorStrings: 0,
      monoLabels: 0,
      arrowLinks: 0,
      numberedMarkers: 0,
      headlineEmphasis: 0,
      bigNumberHero: false,
      gradientWashes: 0,
    };
    const addSaturated = (color) => {
      if (color.a > 0 && chromaOf(color) >= SATURATED_MIN_CHROMA) {
        saturatedHues.add(Math.floor(hueOf(color) / HUE_BUCKET_DEGREES));
      }
    };
    const firstHeading = document.querySelector("h1, h2");
    if (firstHeading)
      facts.headingIsSerif = isSerifStack(
        getComputedStyle(firstHeading).fontFamily,
      );

    for (const element of elements) {
      const style = getComputedStyle(element);
      if (!isVisible(element, style)) continue;
      const text = ownText(element);
      if (style.boxShadow !== "none")
        shadows.set(style.boxShadow, (shadows.get(style.boxShadow) ?? 0) + 1);
      if (parseFloat(style.borderTopLeftRadius) > 0)
        radii.add(style.borderTopLeftRadius);
      addSaturated(readColor(style.backgroundColor));
      if (text) addSaturated(readColor(style.color));
      if (style.backgroundImage.includes("gradient")) facts.gradientWashes += 1;

      const hasHairline = [style.borderTopWidth, style.borderBottomWidth].some(
        (width) =>
          parseFloat(width) > 0 && parseFloat(width) <= HAIRLINE_MAX_PX,
      );
      if (hasHairline) facts.hairlines += 1;
      const trackCount = style.gridTemplateColumns.split(" ").length;
      const isDense =
        Number(style.columnCount) >= DENSE_MIN_COLUMNS ||
        (style.display === "grid" && trackCount >= DENSE_MIN_COLUMNS);
      if (isDense) facts.denseColumns += 1;

      if (/^H[1-3]$/.test(element.tagName)) {
        const above = element.previousElementSibling;
        if (
          above &&
          ownText(above) &&
          isTrackedLabelStyle(getComputedStyle(above))
        )
          facts.labelsAboveHeadings += 1;
        if (
          element.tagName !== "H3" &&
          hasHeadlineEmphasis(element, style, readColor)
        )
          facts.headlineEmphasis += 1;
      }
      if (!text) continue;
      if (SEPARATOR_STRING.test(text)) facts.separatorStrings += 1;
      if (
        element.matches("a, button") &&
        TRAILING_ARROW.test(element.textContent)
      )
        facts.arrowLinks += 1;
      if (NUMBERED_MARKER.test(text)) facts.numberedMarkers += 1;
      const isSmallMono =
        MONO_STACK.test(style.fontFamily) &&
        parseFloat(style.fontSize) < MONO_LABEL_MAX_PX &&
        !element.closest("code, pre");
      if (isSmallMono) facts.monoLabels += 1;
      const isAboveFold =
        element.getBoundingClientRect().top + window.scrollY < FOLD_PX;
      if (
        isAboveFold &&
        parseFloat(style.fontSize) >= BIG_NUMBER_MIN_PX &&
        BIG_NUMBER.test(text)
      ) {
        facts.bigNumberHero = true;
      }
    }
    facts.saturatedHues = saturatedHues.size;
    facts.distinctRadii = radii.size;

    const layout = [];
    sketchLayout(document.body, pageWidth, 0, layout);
    return {
      shadows: ranked(shadows),
      layout,
      paletteFamily: paletteFamilyOf(facts.pageBackground),
      tells: detectTells({
        ...facts,
        ...countIdenticalCards(elements, readColor),
      }),
    };
  }

  if (typeof document !== "undefined") return fingerprintPage();
  return { detectTells, paletteFamilyOf };
})();
