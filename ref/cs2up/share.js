(function () {
  const CORE = window.CS2UPCore || {};
  const coreFormat = CORE.format || {};
  const coreCollections = CORE.collections || {};
  const coreImages = CORE.images || {};
  const {
    safeNumber,
    formatMoney,
    formatPercent,
    formatFloat,
    formatPosterInt,
    formatPosterMoney,
    formatPosterWear,
    formatPosterDate,
    normalizeText,
  } = coreFormat;
  const {
    collectionDisplayName,
    collectionToCaseName,
    normalizeRarityId,
    nextRarityId,
    rarityLabel,
    recipeTitle,
    RARITY_LABELS,
    RARITY_ORDER,
  } = coreCollections;
  const { getItemImageUrl, ensureItemImagesLoaded, normalizeName } = coreImages;
  const SHARE_PAGE_KEY = "csgoup_share_recipe_v1";
  const CAPTURE_QUERY_KEY = "capture";
  const CAPTURE_TARGET_QUERY_KEY = "target";
  const SHARE_STYLE_KEY = "csgoup_share_style_v1";
  function formatMultiple(roi) {
    return `${(safeNumber(roi) + 1).toFixed(2)}x`;
  }

  function firstFiniteNumber(...values) {
    for (const value of values) {
      const num = Number(value);
      if (Number.isFinite(num)) return num;
    }
    return 0;
  }

  function rarityColorFromValue(value, fallback = "#4b69ff") {
    const text = String(value || "").trim().toLowerCase();
    const labels = String(value || "").trim();
    const colorMap = [
      [/consumer|消费/u, "#b0c3d9"],
      [/industrial|工业/u, "#5e98d9"],
      [/mil|rare|军规/u, "#4b69ff"],
      [/restricted|受限/u, "#8847ff"],
      [/classified|保密/u, "#d32ce6"],
      [/covert|隐秘/u, "#eb4b4b"],
      [/contraband|违禁/u, "#e4ae39"],
    ];
    const matched = colorMap.find(([pattern]) => pattern.test(text) || pattern.test(labels));
    return matched ? matched[1] : fallback;
  }

  function toCaptureImageUrl(src) {
    const raw = String(src || "").trim();
    if (!raw) return "";
    if (/^data:/i.test(raw)) return raw;
    try {
      const parsed = new URL(raw, window.location.href);
      if (parsed.origin === window.location.origin) return parsed.href;
      return `/api/image-proxy?url=${encodeURIComponent(parsed.href)}`;
    } catch {
      return raw;
    }
  }

  function decodePayloadFromQuery() {
    try {
      const params = new URLSearchParams(window.location.search);
      const raw = params.get("payload");
      if (!raw) return null;
      const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
      const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
      const decoded = atob(padded);
      const bytes = Uint8Array.from(decoded, (char) => char.charCodeAt(0));
      const text = new TextDecoder().decode(bytes);
      const payload = JSON.parse(text);
      return payload && typeof payload === "object" ? payload : null;
    } catch {
      return null;
    }
  }


  async function fetchPayloadBySid() {
    const params = new URLSearchParams(window.location.search);
    const sid = String(params.get("sid") || "").trim();
    if (!sid) return null;
    const response = await fetch(`/api/share-payloads?id=${encodeURIComponent(sid)}`, {
      headers: { Accept: "application/json" },
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok || !data?.payload) {
      throw new Error(data?.error || "分享链接已失效，请返回配方页重新复制。");
    }
    return data.payload;
  }
  function parseRealtimeShareQuery() {
    const params = new URLSearchParams(window.location.search);
    const rawId = String(params.get("id") || "").trim();
    const mode = String(params.get("mode") || "spot").trim().toLowerCase() || "spot";
    const bucket = String(params.get("bucket") || "").trim();
    const detailId = Number(rawId);
    if (!Number.isFinite(detailId)) return null;
    return { id: detailId, mode, bucket };
  }

  function sanitizeWearDisplay(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    const numeric = Number(text);
    if (Number.isFinite(numeric) && /^-?\d+(?:\.\d+)?$/.test(text)) return formatFloat(numeric);
    return text.replace(/-?\d+\.\d{7,}/g, (match) => formatFloat(Number(match)));
  }

  function wearConditionLabel(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return "";
    if (num < 0.07) return "崭新";
    if (num < 0.15) return "略磨";
    if (num < 0.38) return "久经";
    if (num < 0.45) return "破损";
    return "战痕";
  }

  function captionMoney(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return "0";
    return num >= 100 ? num.toFixed(0) : num.toFixed(2).replace(/\.?0+$/u, "");
  }

  function captionDate(value) {
    const date = value ? new Date(value) : new Date();
    if (Number.isNaN(date.getTime())) return "";
    return `${date.getMonth() + 1}.${date.getDate()}`;
  }

  function buildSharePayload(summary, recipe) {
    const inputs = Array.isArray(recipe?.inputs) ? recipe.inputs : [];
    const outputs = Array.isArray(recipe?.outputs) ? recipe.outputs.slice() : [];
    const expandedInputs = [];
    inputs.forEach((item, groupIndex) => {
      const count = Math.max(1, Number(item?.count || 1));
      for (let index = 0; index < count; index += 1) {
        expandedInputs.push({
          key: `input-${groupIndex}-${index}`,
          name: String(item?.name || "").trim(),
              cn: String(item?.cn || item?.name || "").trim(),
              collection: String(item?.collection || "").trim(),
              unit_price: Number(item?.unit_price || 0),
              wear: firstFiniteNumber(item?.wear, item?.float, item?.float_value, item?.wear_float, item?.avg_wear),
              image: getItemImageUrl(item?.name, item?.cn),
            });
      }
    });
    const sortedOutputs = outputs
      .map((item, index) => ({
        key: `output-${index}`,
        name: String(item?.name || "").trim(),
        cn: String(item?.cn || item?.name || "").trim(),
        collection: String(item?.collection || "").trim(),
        probability: Number(item?.probability || 0),
        expected_wear: Number(item?.expected_wear),
        price: Number(item?.price || 0),
        image: getItemImageUrl(item?.name, item?.cn),
      }))
      .sort((a, b) => Number(b.price || 0) - Number(a.price || 0) || Number(b.probability || 0) - Number(a.probability || 0));
    const maxOutputValue = Math.max(Number(summary?.max_output || 0), Number(sortedOutputs[0]?.price || 0));
    const normalizedRarity = normalizeRarityId(summary?.rarity_id);
    const nextRarityIdValue =
      String(summary?.next_rarity_id || recipe?.next_rarity_id || "").trim() || nextRarityId(normalizedRarity);
    const nextRarityLabelValue =
      String(summary?.next_rarity_label || recipe?.next_rarity_label || "").trim() || rarityLabel(nextRarityIdValue);
    const matchup = String(summary?.collection_matchup || "").trim() || "默认配比";
    const wearText = sanitizeWearDisplay(summary?.wear);
    const subtitle = [wearText, summary?.stattrak ? "暗金" : "普通"].filter(Boolean).join(" | ");
    return {
      created_at: Date.now(),
      title: recipeTitle(summary),
      subtitle,
      recipe_line: `${matchup}｜${rarityLabel(normalizedRarity)}→${nextRarityLabelValue}`,
      matchup,
      input_rarity_label: rarityLabel(normalizedRarity),
      output_rarity_label: nextRarityLabelValue,
      stattrak: Boolean(summary?.stattrak),
      metrics: {
        cost: Number(summary?.cost || 0),
        expected: Number(summary?.expected_value_net ?? summary?.expected_value ?? 0),
        roi: Number(summary?.roi || 0),
        break_even_rate: Number(summary?.break_even_rate || 0),
        max_output: maxOutputValue,
        max_profit: Number(maxOutputValue - Number(summary?.cost || 0)),
      },
      materials: expandedInputs,
      outputs: sortedOutputs,
      collections: Array.isArray(summary?.collections) ? summary.collections.filter(Boolean) : [],
      hero_output: sortedOutputs[0] || null,
    };
  }

  function isCaptureMode() {
    const params = new URLSearchParams(window.location.search);
    return params.get(CAPTURE_QUERY_KEY) === "1";
  }

  function captureTarget() {
    const params = new URLSearchParams(window.location.search);
    return String(params.get(CAPTURE_TARGET_QUERY_KEY) || "").trim();
  }

  document.addEventListener("alpine:init", () => {
    Alpine.data("recipeSharePage", () => ({
      payload: null,
      snapshotText: "",
      desktopScale: 1,
      desktopScaledHeight: 0,
      desktopScaledWidth: 0,
      posterScale: 1,
      posterScaledHeight: 0,
      posterScaledWidth: 0,
      shareSaveBusy: false,
      posterSaveBusy: false,
      sectionSaveBusy: "",
      bulkSaveBusy: false,
      copyBusy: false,
      saveMessage: "",
      captureMode: false,
      shareStyle: "dark",

      init() {
        this.captureMode = isCaptureMode();
        if (this.captureMode) {
          document.body.classList.add("share-capture");
          const target = captureTarget();
          if (target) {
            document.body.classList.add(`share-capture-${target}`);
          }
          if (["light", "light-materials", "light-outputs"].includes(target)) this.shareStyle = "light";
        } else {
          const storedStyle = localStorage.getItem(SHARE_STYLE_KEY);
          this.shareStyle = storedStyle === "light" ? "light" : "dark";
        }
        this.readPayload();
        this.$nextTick(() => this.updateDesktopScale());
        window.addEventListener("resize", () => this.updateDesktopScale(), { passive: true });
      },

      async fetchRealtimePayload() {
        const query = parseRealtimeShareQuery();
        if (!query) return null;
        const params = new URLSearchParams();
        params.set("mode", query.mode);
        params.set("id", String(query.id));
        if (query.bucket) params.set("bucket", query.bucket);
        const response = await fetch(`/api/recipe-detail?${params.toString()}`, {
          credentials: "same-origin",
          headers: {
            Accept: "application/json",
          },
        });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.ok || !data?.recipe) {
          throw new Error(data?.error || "分享链接已失效，请返回配方页重新复制。");
        }
        const variants = Array.isArray(data?.variants) ? data.variants : [];
        const activeSummary = variants.find((item) => Number(item?.detail_id || 0) === query.id) || variants[0] || null;
        if (!activeSummary) {
          throw new Error("当前配方已失效，请返回列表重新分享。");
        }
      return buildSharePayload(activeSummary, data.recipe);
      },

      async readPayload() {
        try {
          const fromSid = await fetchPayloadBySid().catch(() => null);
          const fromQuery = fromSid || decodePayloadFromQuery();
          if (fromQuery) {
            this.payload = fromQuery;
          } else {
            const realtimePayload = await this.fetchRealtimePayload().catch(() => null);
            if (realtimePayload) {
              this.payload = realtimePayload;
            } else {
              if (this.captureMode) {
                this.payload = null;
                return;
              }
              const raw = localStorage.getItem(SHARE_PAGE_KEY);
              if (!raw) {
                this.payload = null;
                return;
              }
              const parsed = JSON.parse(raw);
              this.payload = parsed && typeof parsed === "object" ? parsed : null;
            }
          }
          this.snapshotText = this.payload?.created_at
            ? new Date(this.payload.created_at).toLocaleString("zh-CN", { hour12: false })
            : new Date().toLocaleString("zh-CN", { hour12: false });
          this.$nextTick(() => this.updateDesktopScale());
        } catch {
          this.payload = null;
        }
      },

      collectionDisplayName(name) {
        return collectionDisplayName(name);
      },

      formatMoney,
      formatPercent,
      formatFloat,
      formatMultiple,
      formatPosterInt,
      formatPosterMoney,
      formatPosterDate,

      formatProfit(value) {
        const num = safeNumber(value);
        const prefix = num >= 0 ? "+" : "";
        return `${prefix}${formatMoney(num)}`;
      },

      maxOutputValue() {
        const metricValue = safeNumber(this.payload?.metrics?.max_output || 0);
        const outputs = Array.isArray(this.payload?.outputs) ? this.payload.outputs : [];
        const outputMax = outputs.reduce((best, item) => Math.max(best, safeNumber(item?.price || 0)), 0);
        return Math.max(metricValue, outputMax);
      },

      maxProfitValue() {
        return this.maxOutputValue() - safeNumber(this.payload?.metrics?.cost || 0);
      },

      maxOutputCostRatioText() {
        const cost = safeNumber(this.payload?.metrics?.cost || 0);
        if (cost <= 0) return "--";
        return `${(this.maxOutputValue() / cost).toFixed(2)}x`;
      },

      itemImage(item) {
        const raw = item?.image || getItemImageUrl(item?.name, item?.cn);
        return toCaptureImageUrl(raw);
      },

      heroTitle() {
        const rawTitle = this.payload?.hero_output?.cn || this.payload?.hero_output?.name || this.payload?.title || "";
        return normalizeName(rawTitle) || String(rawTitle || "").trim();
      },

      heroImage() {
        return this.itemImage(this.payload?.hero_output || {});
      },

      heroWearText() {
        return formatFloat(this.payload?.hero_output?.expected_wear);
      },

      floatBarStyle(value) {
        const num = Math.max(0, Math.min(1, safeNumber(value)));
        return { "--share-progress": `${(num * 100).toFixed(2)}%` };
      },

      wearValue(item, preferredKey = "wear") {
        const keys = [
          preferredKey,
          "wear",
          "float",
          "float_value",
          "wear_float",
          "avg_wear",
          "expected_wear",
        ];
        for (const key of keys) {
          const value = Number(item?.[key]);
          if (Number.isFinite(value)) return value;
        }
        return 0;
      },

      wearText(item, preferredKey = "wear") {
        const value = this.wearValue(item, preferredKey);
        return formatFloat(value);
      },

      wearLabel(item, preferredKey = "wear") {
        return wearConditionLabel(this.wearValue(item, preferredKey));
      },

      rarityColorStyle(item, fallbackLabel = "") {
        const color = rarityColorFromValue(
          item?.rarity_id || item?.rarity || item?.rarity_label || fallbackLabel,
          rarityColorFromValue(fallbackLabel)
        );
        return { "--share-rarity-color": color };
      },

      topOutputs() {
        return Array.isArray(this.payload?.outputs) ? this.payload.outputs.slice(0, 6) : [];
      },

      lightMaterials() {
        return Array.isArray(this.payload?.materials) ? this.payload.materials.slice(0, 10) : [];
      },

      lightOutputs() {
        return Array.isArray(this.payload?.outputs) ? this.payload.outputs : [];
      },

      lightMaterialGroups() {
        const materials = this.lightMaterials();
        const groups = new Map();
        materials.forEach((item) => {
          const key = String(item?.collection || "").trim() || "__unknown__";
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(item);
        });
        return Array.from(groups.entries()).map(([key, items]) => ({
          key,
          title: collectionDisplayName(key) || "配方饰品",
          items,
        }));
      },

      lightOutputGroups() {
        const outputs = this.lightOutputs();
        const groups = new Map();
        outputs.forEach((item) => {
          const key = String(item?.collection || "").trim() || "__unknown__";
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(item);
        });
        return Array.from(groups.entries()).map(([key, items]) => ({
          key,
          title: collectionDisplayName(key) || "潜在产物",
          items: items.slice(0, 4),
        }));
      },

      lightCollectionTitle(items) {
        const first = Array.isArray(items) ? items[0] : null;
        return collectionDisplayName(first?.collection || "").replace(/武器箱/u, "收藏品") || "配方饰品";
      },

      shortItemName(item) {
        return normalizeName(item?.cn || item?.name || "") || String(item?.cn || item?.name || "").trim();
      },

      setShareStyle(style) {
        const nextStyle = style === "light" ? "light" : "dark";
        this.shareStyle = nextStyle;
        if (!this.captureMode) localStorage.setItem(SHARE_STYLE_KEY, nextStyle);
        this.$nextTick(() => this.updateDesktopScale());
      },

      posterMatchupText() {
        const matchup = String(this.payload?.matchup || "").trim() || "默认配比";
        const parts = matchup
          .split(/打/u)
          .map((part) => String(part || "").trim())
          .filter(Boolean);
        if (parts.length >= 2 && parts.every((part) => /^\d+$/.test(part))) {
          return parts.join(" 打 ");
        }
        const matched = matchup.match(/(\d+)\s*打\s*(\d+)/u);
        if (matched) return `${matched[1]} 打 ${matched[2]}`;
        return matchup;
      },

      posterMaterialGroups() {
        const materials = Array.isArray(this.payload?.materials) ? this.payload.materials : [];
        const orderedCollections = Array.isArray(this.payload?.collections) ? this.payload.collections : [];
        const groups = new Map();
        materials.forEach((item) => {
          const key = String(item?.collection || "").trim() || "__unknown__";
          if (!groups.has(key)) groups.set(key, new Map());
          const itemKey = [
            String(item?.cn || item?.name || "").trim(),
            String(item?.wear_name || item?.wear_label || "").trim(),
            Number.isFinite(Number(item?.wear)) ? Number(item.wear).toFixed(6) : "",
          ].join("|");
          const collectionItems = groups.get(key);
          if (!collectionItems.has(itemKey)) {
            collectionItems.set(itemKey, {
              ...item,
              count: Math.max(1, Number(item?.count || 1)),
            });
            return;
          }
          collectionItems.get(itemKey).count += Math.max(1, Number(item?.count || 1));
        });
        const orderedKeys = [];
        orderedCollections.forEach((key) => {
          if (groups.has(key) && !orderedKeys.includes(key)) orderedKeys.push(key);
        });
        Array.from(groups.keys()).forEach((key) => {
          if (!orderedKeys.includes(key)) orderedKeys.push(key);
        });
        return orderedKeys.map((key) => ({
          key,
          collection: collectionDisplayName(key).replace(/武器箱/u, "").replace(/收藏品/u, ""),
          items: Array.from((groups.get(key) || new Map()).values()),
        }));
      },

      posterMaterialLine(item) {
        const count = Math.max(1, Number(item?.count || 1));
        const wearValue = Number(item?.wear);
        const wearText = Number.isFinite(wearValue) ? formatPosterWear(wearValue) : "";
        const displayName = String(item?.cn || item?.name || "").trim();
        const hasConditionInName = /崭新出厂|略有磨损|久经沙场|破损不堪|战痕累累|Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred/iu.test(displayName);
        const wearName = String(item?.wear_name || item?.wear_label || (hasConditionInName ? "" : wearConditionLabel(wearValue))).trim();
        return `${count}× ${displayName}${wearName ? ` ${wearName}` : ""}${wearText ? ` ${wearText}` : ""}`.trim();
      },

      posterCaptionLines() {
        const groups = this.posterMaterialGroups();
        const date = captionDate(this.payload?.created_at);
        const breakEven = formatPercent(this.payload?.metrics?.break_even_rate || 0);
        const cost = captionMoney(this.payload?.metrics?.cost || 0);
        const expected = captionMoney(this.payload?.metrics?.expected || 0);
        const maxOutput = captionMoney(this.maxOutputValue());
        const roi = formatPercent(this.payload?.metrics?.roi || 0);
        const maxMultiple = this.maxOutputCostRatioText().replace(/x$/u, "倍");
        const matchup = this.posterMatchupText();
        const inputRarity = this.payload?.input_rarity_label || "";
        const outputRarity = this.payload?.output_rarity_label || "";
        const topOutputs = Array.isArray(this.payload?.outputs)
          ? this.payload.outputs.slice().sort((a, b) => Number(b?.price || 0) - Number(a?.price || 0)).slice(0, 2)
          : [];
        const outputLines = topOutputs.length
          ? [
              "",
              "🎯主要产物",
              ...topOutputs.map((item) => {
                const probability = formatPercent(item?.probability || 0);
                const name = String(item?.cn || item?.name || "").trim();
                return `${probability} ${name} ¥${captionMoney(item?.price || 0)}`;
              }),
            ]
          : [];
        return [
          `【CS2炼金】${date}正期望配方分享🔥`,
          "",
          "每日正期望配方来啦～",
          `CS2 ${date}炼金配方｜${breakEven}概率！模拟价值${expected}，最高产物${maxOutput}🔥`,
          `${matchup} ${inputRarity}升${outputRarity}`,
          `成本${cost}，最高能出${maxOutput}`,
          `ROI ${roi}，最高产物约${maxMultiple}成本，上限真的绝！`,
          "",
          "📦材料明细",
          ...groups.flatMap((group) => [
            `【${group.collection}】`,
            ...group.items.map((item) => this.posterMaterialLine(item)),
          ]),
          ...outputLines,
          "",
          "⚠️提醒：各饰品磨损区间不一样哦～这个是归一化磨损对比后性价比最顶的组合！价格会波动，下单前记得再核价。",
          "#csgo炼金# #cs2炼金配方# #cs2up#",
        ];
      },

      posterCaptionText() {
        return this.posterCaptionLines().join("\n");
      },

      desktopScaleStyle() {
        if (this.captureMode || window.innerWidth < 981) return {};
        return {
          width: this.desktopScaledWidth > 0 ? `${this.desktopScaledWidth}px` : "auto",
          height: this.desktopScaledHeight > 0 ? `${this.desktopScaledHeight}px` : "auto",
          transform: `scale(${this.desktopScale})`,
        };
      },

      posterScaleStyle() {
        if (this.captureMode || window.innerWidth < 981) return {};
        return {
          width: this.posterScaledWidth > 0 ? `${this.posterScaledWidth}px` : "auto",
          height: this.posterScaledHeight > 0 ? `${this.posterScaledHeight}px` : "auto",
          transform: `scale(${this.posterScale})`,
        };
      },

      updateDesktopScale() {
        if (!this.payload) return;

        if (this.captureMode || window.innerWidth < 981) {
          this.desktopScale = 1;
          this.desktopScaledHeight = 0;
          this.desktopScaledWidth = 0;
          this.posterScale = 1;
          this.posterScaledHeight = 0;
          this.posterScaledWidth = 0;
          return;
        }

        const inner = this.$refs?.scaleInner;
        if (inner) {
          const naturalWidth = inner.offsetWidth || 1180;
          const naturalHeight = inner.offsetHeight || 1200;
          const wrap = this.$refs?.scaleWrap;
          const wrapParent = wrap?.parentElement;
          const availableWidth = Math.max(320, (wrapParent?.clientWidth || window.innerWidth) - 8);
          const availableHeight = Math.max(320, (wrapParent?.clientHeight || window.innerHeight) - 8);
          const scale = Math.min(1, availableWidth / naturalWidth, availableHeight / naturalHeight);

          this.desktopScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
          this.desktopScaledWidth = naturalWidth;
          this.desktopScaledHeight = naturalHeight * this.desktopScale;
        }

        const posterInner = this.$refs?.posterInner;
        if (posterInner) {
          const posterNaturalWidth = posterInner.offsetWidth || 416;
          const posterNaturalHeight = posterInner.offsetHeight || 555;
          const posterWrapBody = this.$refs?.posterWrapBody;
          if (posterWrapBody) {
            const availableHeight = Math.max(200, posterWrapBody.clientHeight);
            const availableWidth = Math.max(200, posterWrapBody.clientWidth);
            const pScale = Math.min(1, availableWidth / posterNaturalWidth, availableHeight / posterNaturalHeight);

            this.posterScale = Number.isFinite(pScale) && pScale > 0 ? pScale : 1;
            this.posterScaledWidth = posterNaturalWidth * this.posterScale;
            this.posterScaledHeight = posterNaturalHeight * this.posterScale;
          }
        }
      },

      async requestCapture(selector, filenameBase, target = "") {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => controller.abort(), 60000);
        let resp = null;
        try {
          resp = await fetch("/api/share-capture", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
              payload: this.payload,
              selector,
              target,
            }),
          });
        } catch (err) {
          if (err?.name === "AbortError") {
            throw new Error("截图请求超时，请稍后重试");
          }
          throw err;
        } finally {
          window.clearTimeout(timeoutId);
        }
        let data = null;
        const contentType = String(resp.headers.get("Content-Type") || "");
        if (!resp.ok) {
          if (contentType.includes("application/json")) {
            data = await resp.json();
          }
          throw new Error(data?.error || `保存失败 (${resp.status})`);
        }
        const blob = await resp.blob();
        if (!blob || blob.size <= 0) {
          throw new Error("截图结果为空");
        }

        const downloadUrl = URL.createObjectURL(blob);
        const link = document.createElement("a");
        const baseName = String(filenameBase || this.payload?.title || "recipe-share").replace(/[\\/:*?"<>|]+/g, "_");
        link.href = downloadUrl;
        link.download = `${baseName}.png`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(downloadUrl);
      },

      shareCaptureTask() {
        const baseTitle = this.payload?.title || "recipe-share";
        if (this.shareStyle === "light") {
          return {
            selector: ".share-card-light",
            filenameBase: `${baseTitle}-light`,
            target: "light",
          };
        }
        return {
          selector: ".share-card",
          filenameBase: baseTitle,
          target: "",
        };
      },

      allCaptureTasks() {
        const baseTitle = this.payload?.title || "recipe-share";
        return [
          this.shareCaptureTask(),
          {
            selector: ".share-light-material-capture",
            filenameBase: `${baseTitle}-materials`,
            target: "light-materials",
          },
          {
            selector: ".share-light-output-capture",
            filenameBase: `${baseTitle}-outputs`,
            target: "light-outputs",
          },
          {
            selector: ".share-sidepanel .share-poster-preview",
            filenameBase: `${baseTitle}-poster`,
            target: "poster",
          },
        ];
      },

      isAnySaveBusy() {
        return Boolean(this.shareSaveBusy || this.posterSaveBusy || this.sectionSaveBusy || this.bulkSaveBusy);
      },

      async saveAllImages() {
        if (this.isAnySaveBusy() || !this.payload || this.captureMode) return;
        this.bulkSaveBusy = true;
        this.saveMessage = "正在并发导出 4 张图片...";
        try {
          const tasks = this.allCaptureTasks();
          const results = await Promise.allSettled(
            tasks.map((task) => this.requestCapture(task.selector, task.filenameBase, task.target))
          );
          const okCount = results.filter((result) => result.status === "fulfilled").length;
          const failCount = results.length - okCount;
          if (failCount > 0) {
            const firstError = results.find((result) => result.status === "rejected")?.reason;
            this.saveMessage = `已开始下载 ${okCount} 张，失败 ${failCount} 张：${firstError?.message || "请重试"}`;
          } else {
            this.saveMessage = `已并发导出 ${okCount} 张图片`;
          }
        } finally {
          this.bulkSaveBusy = false;
          window.setTimeout(() => {
            this.saveMessage = "";
          }, 3600);
        }
      },

      async saveShareImage() {
        if (this.isAnySaveBusy() || !this.payload || this.captureMode) return;
        this.shareSaveBusy = true;
        this.saveMessage = "";
        try {
          const task = this.shareCaptureTask();
          await this.requestCapture(task.selector, task.filenameBase, task.target);
          this.saveMessage = "分享海报已开始下载";
        } catch (err) {
          this.saveMessage = err?.message || "分享海报导出失败，请重试";
        } finally {
          this.shareSaveBusy = false;
          window.setTimeout(() => {
            this.saveMessage = "";
          }, 2600);
        }
      },

      async saveLightMaterialsImage() {
        if (this.isAnySaveBusy() || !this.payload || this.captureMode) return;
        this.sectionSaveBusy = "materials";
        this.saveMessage = "";
        try {
          await this.requestCapture(
            ".share-light-material-capture",
            `${this.payload?.title || "recipe-share"}-materials`,
            "light-materials"
          );
          this.saveMessage = "材料区域已开始下载";
        } catch (err) {
          this.saveMessage = err?.message || "材料区域导出失败，请重试";
        } finally {
          this.sectionSaveBusy = "";
          window.setTimeout(() => {
            this.saveMessage = "";
          }, 2600);
        }
      },

      async saveLightOutputsImage() {
        if (this.isAnySaveBusy() || !this.payload || this.captureMode) return;
        this.sectionSaveBusy = "outputs";
        this.saveMessage = "";
        try {
          await this.requestCapture(
            ".share-light-output-capture",
            `${this.payload?.title || "recipe-share"}-outputs`,
            "light-outputs"
          );
          this.saveMessage = "模拟结果已开始下载";
        } catch (err) {
          this.saveMessage = err?.message || "模拟结果导出失败，请重试";
        } finally {
          this.sectionSaveBusy = "";
          window.setTimeout(() => {
            this.saveMessage = "";
          }, 2600);
        }
      },

      async savePosterImage() {
        if (this.isAnySaveBusy() || !this.payload || this.captureMode) return;
        this.posterSaveBusy = true;
        this.saveMessage = "";
        try {
          await this.requestCapture(".share-sidepanel .share-poster-preview", `${this.payload?.title || "recipe-share"}-poster`, "poster");
          this.saveMessage = "作品海报已开始下载";
        } catch (err) {
          this.saveMessage = err?.message || "作品海报导出失败，请重试";
        } finally {
          this.posterSaveBusy = false;
          window.setTimeout(() => {
            this.saveMessage = "";
          }, 2600);
        }
      },

      async copyPosterCaption() {
        if (this.copyBusy || !this.payload) return;
        this.copyBusy = true;
        this.saveMessage = "";
        try {
          const text = this.posterCaptionText();
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
          } else {
            const textarea = document.createElement("textarea");
            textarea.value = text;
            textarea.setAttribute("readonly", "readonly");
            textarea.style.position = "fixed";
            textarea.style.opacity = "0";
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand("copy");
            textarea.remove();
          }
          this.saveMessage = "作品文案已复制";
        } catch (err) {
          this.saveMessage = err?.message || "作品文案复制失败，请重试";
        } finally {
          this.copyBusy = false;
          window.setTimeout(() => {
            this.saveMessage = "";
          }, 2600);
        }
      },
    }));
  });
})();
