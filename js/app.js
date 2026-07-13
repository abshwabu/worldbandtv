/* =========================================================================
   WorldBand TV — app.js
   Streams playlists from iptv-org/iptv (via their GitHub Pages-hosted M3U
   files), lets the user add their own playlist URLs, and plays channels
   full-screen with a custom remote-control navigation layer.
   ========================================================================= */

(function () {
  "use strict";

  const IPTV_BASE = "https://iptv-org.github.io/iptv";
  const API_BASE = "https://iptv-org.github.io/api";

  // Known iptv-org categories, minus "xxx" (adult), which this app never
  // surfaces. See README for the additional NSFW filter applied to all
  // parsed playlists, including user-supplied ones.
  const CATEGORIES = [
    ["general", "General"], ["news", "News"], ["sports", "Sports"],
    ["movies", "Movies"], ["series", "Series"], ["entertainment", "Entertainment"],
    ["music", "Music"], ["kids", "Kids"], ["family", "Family"],
    ["documentary", "Documentary"], ["education", "Education"], ["science", "Science"],
    ["culture", "Culture"], ["lifestyle", "Lifestyle"], ["cooking", "Cooking"],
    ["travel", "Travel"], ["outdoor", "Outdoor"], ["relax", "Relax"],
    ["comedy", "Comedy"], ["classic", "Classic"], ["animation", "Animation"],
    ["business", "Business"], ["auto", "Auto"], ["religious", "Religious"],
    ["legislative", "Legislative"], ["shop", "Shopping"], ["weather", "Weather"]
  ];

  // Bundled local playlists (id, display name, path relative to app root).
  const BUILTIN_PLAYLISTS = [
    ["bein", "BeIN", "playlists/bein.m3u"]
  ];

  const NSFW_PATTERN = /adult|xxx|porn|erotic/i;

  /* ---------------------------------------------------------------------
     M3U parsing
     --------------------------------------------------------------------- */
  function parseM3U(text, fallbackGroup) {
    const lines = text.split(/\r?\n/);
    const channels = [];
    let current = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith("#EXTINF")) {
        const attrs = {};
        const attrRe = /([\w-]+)="([^"]*)"/g;
        let m;
        while ((m = attrRe.exec(line))) attrs[m[1].toLowerCase()] = m[2];
        const nameMatch = line.match(/,(.*)$/);
        current = {
          id: attrs["tvg-id"] || "",
          name: (nameMatch ? nameMatch[1].trim() : "Unnamed channel"),
          logo: attrs["tvg-logo"] || "",
          group: attrs["group-title"] || fallbackGroup || "",
          country: attrs["tvg-country"] || ""
        };
      } else if (line.startsWith("#")) {
        continue; // skip other directives (#EXTVLCOPT, #EXTM3U, #EXT-X-*)
      } else if (current) {
        current.url = line;
        current.uid = current.id || (current.name + "|" + current.url);
        channels.push(current);
        current = null;
      }
    }
    return channels.filter((c) => !NSFW_PATTERN.test(c.group) && !NSFW_PATTERN.test(c.name));
  }

  async function fetchM3U(url, fallbackGroup) {
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const text = await res.text();
    return parseM3U(text, fallbackGroup);
  }

  /* ---------------------------------------------------------------------
     State + persistence
     --------------------------------------------------------------------- */
  const state = { stations: [], current: null, currentIndex: -1, view: "search", allIndexCache: null };
  const LS_FAV = "wbtv_favorites";
  const LS_RECENT = "wbtv_recent";
  const LS_PLAYLISTS = "wbtv_playlists";
  const LS_HIDDEN = "wbtv_hidden";

  function readLS(key) { try { return JSON.parse(localStorage.getItem(key)) || []; } catch (e) { return []; } }
  function writeLS(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {} }

  function filterHidden(list) {
    const hidden = new Set(readLS(LS_HIDDEN));
    return list.filter((c) => !hidden.has(c.uid));
  }
  function hideChannelUid(uid) {
    const hidden = readLS(LS_HIDDEN);
    if (!hidden.includes(uid)) hidden.push(uid);
    writeLS(LS_HIDDEN, hidden);
  }

  function isFavorite(uid) { return readLS(LS_FAV).some((c) => c.uid === uid); }
  function toggleFavorite(ch) {
    const favs = readLS(LS_FAV);
    const idx = favs.findIndex((c) => c.uid === ch.uid);
    if (idx >= 0) favs.splice(idx, 1); else favs.unshift(ch);
    writeLS(LS_FAV, favs);
    return idx < 0;
  }
  function pushRecent(ch) {
    let recent = readLS(LS_RECENT).filter((c) => c.uid !== ch.uid);
    recent.unshift(ch);
    writeLS(LS_RECENT, recent.slice(0, 24));
  }

  /* ---------------------------------------------------------------------
     DOM refs
     --------------------------------------------------------------------- */
  const el = {
    grid: document.getElementById("grid"),
    loader: document.getElementById("loader"),
    loaderText: document.getElementById("loaderText"),
    empty: document.getElementById("emptyState"),
    stageTitle: document.getElementById("stageTitle"),
    stageSubtitle: document.getElementById("stageSubtitle"),
    searchBox: document.getElementById("searchBox"),
    searchInput: document.getElementById("searchInput"),
    categoryList: document.getElementById("categoryList"),
    countryList: document.getElementById("countryList"),
    customPlaylistList: document.getElementById("customPlaylistList"),
    addPlaylistBtn: document.getElementById("addPlaylistBtn"),
    toast: document.getElementById("toast"),
    modalBackdrop: document.getElementById("modalBackdrop"),
    playlistUrlInput: document.getElementById("playlistUrlInput"),
    playlistNameInput: document.getElementById("playlistNameInput"),
    modalCancel: document.getElementById("modalCancel"),
    modalSave: document.getElementById("modalSave"),
    playerView: document.getElementById("playerView"),
    playerOverlay: document.getElementById("playerOverlay"),
    video: document.getElementById("video"),
    channelNumber: document.getElementById("channelNumber"),
    playerLogo: document.getElementById("playerLogo"),
    playerName: document.getElementById("playerName"),
    playerMeta: document.getElementById("playerMeta"),
    playerStatus: document.getElementById("playerStatus"),
    playerPrev: document.getElementById("playerPrev"),
    playerNext: document.getElementById("playerNext"),
    playerFav: document.getElementById("playerFav"),
    playerFavLabel: document.getElementById("playerFavLabel"),
    playerHide: document.getElementById("playerHide")
  };

  /* ---------------------------------------------------------------------
     Helpers
     --------------------------------------------------------------------- */
  function showToast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add("show");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.toast.classList.remove("show"), 2800);
  }
  function setLoading(on, text) {
    el.loader.style.display = on ? "flex" : "none";
    if (text) el.loaderText.textContent = text;
    if (on) { el.grid.innerHTML = ""; el.empty.style.display = "none"; }
  }
  function setStageHeader(title, subtitle, showSearch) {
    el.stageTitle.textContent = title;
    el.stageSubtitle.textContent = subtitle || "";
    el.searchBox.style.display = showSearch ? "flex" : "none";
  }
  function setActiveNav(node) {
    document.querySelectorAll(".nav-item").forEach((n) => n.classList.remove("active"));
    if (node) node.classList.add("active");
  }
  function initials(name) { return (name || "?").trim().charAt(0).toUpperCase(); }

  /* ---------------------------------------------------------------------
     Rendering
     --------------------------------------------------------------------- */
  function renderChannels(list) {
    state.stations = filterHidden(list);
    el.grid.innerHTML = "";
    el.empty.style.display = state.stations.length ? "none" : "block";
    const frag = document.createDocumentFragment();
    state.stations.forEach((ch, idx) => {
      const card = document.createElement("div");
      card.className = "card";
      card.tabIndex = 0;
      card.dataset.uid = ch.uid;

      const art = document.createElement("div");
      art.className = "card-art";
      if (ch.logo) {
        const img = document.createElement("img");
        img.src = ch.logo; img.alt = "";
        img.onerror = () => { img.remove(); art.textContent = initials(ch.name); };
        art.appendChild(img);
      } else {
        art.textContent = initials(ch.name);
      }

      const name = document.createElement("div");
      name.className = "card-name";
      name.textContent = ch.name;

      const meta = document.createElement("div");
      meta.className = "card-meta";
      meta.textContent = [ch.group, ch.country].filter(Boolean).join(" · ") || "Channel";

      card.appendChild(art); card.appendChild(name); card.appendChild(meta);
      card.addEventListener("click", () => openPlayer(state.stations, idx));
      frag.appendChild(card);
    });
    el.grid.appendChild(frag);
  }

  /* ---------------------------------------------------------------------
     Views
     --------------------------------------------------------------------- */
  function enterSearchView() {
    setActiveNav(document.querySelector('[data-nav="search"]'));
    state.view = "search";
    setStageHeader("Search Channels", "Type at least 2 characters", true);
    el.grid.innerHTML = ""; el.empty.style.display = "none";
    el.searchInput.focus();
  }

  async function ensureFullIndex() {
    if (state.allIndexCache) return state.allIndexCache;
    setLoading(true, "Loading the full channel index (one-time, may take a moment)…");
    try {
      state.allIndexCache = await fetchM3U(IPTV_BASE + "/index.m3u");
      return state.allIndexCache;
    } finally {
      setLoading(false);
    }
  }

  let searchDebounce;
  el.searchInput.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => runSearch(el.searchInput.value), 450);
  });
  el.searchInput.addEventListener("keydown", (e) => {
    if (e.keyCode === 13) { clearTimeout(searchDebounce); runSearch(el.searchInput.value); }
  });

  async function runSearch(term) {
    const q = term.trim().toLowerCase();
    if (q.length < 2) {
      setStageHeader("Search Channels", "Type at least 2 characters", true);
      el.grid.innerHTML = ""; el.empty.style.display = "none";
      return;
    }
    try {
      const all = await ensureFullIndex();
      const results = all.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 60);
      setStageHeader("Search Channels", results.length + " results for \u201c" + term + "\u201d", true);
      renderChannels(results);
    } catch (e) {
      showToast("Couldn't load the channel index. Check the network connection.");
    }
  }

  async function loadCategory(id, name) {
    state.view = "category";
    setStageHeader(name, "Channels tagged " + name.toLowerCase(), false);
    setLoading(true, "Tuning in " + name + "…");
    try {
      renderChannels(await fetchM3U(IPTV_BASE + "/categories/" + id + ".m3u", name));
    } catch (e) {
      showToast("Couldn't load the " + name + " category.");
      renderChannels([]);
    } finally { setLoading(false); }
  }

  async function loadCountry(code, name) {
    state.view = "country";
    setStageHeader(name, "Channels broadcasting from " + name, false);
    setLoading(true, "Tuning in " + name + "…");
    try {
      renderChannels(await fetchM3U(IPTV_BASE + "/countries/" + code.toLowerCase() + ".m3u"));
    } catch (e) {
      showToast("Couldn't load channels for " + name + ".");
      renderChannels([]);
    } finally { setLoading(false); }
  }

  function loadFavorites() {
    setActiveNav(document.querySelector('[data-nav="favorites"]'));
    state.view = "favorites";
    setStageHeader("Favorites", "Channels you've saved", false);
    renderChannels(readLS(LS_FAV));
  }
  function loadRecent() {
    setActiveNav(document.querySelector('[data-nav="recent"]'));
    state.view = "recent";
    setStageHeader("Recently Watched", "Pick up where you left off", false);
    renderChannels(readLS(LS_RECENT));
  }

  async function loadBuiltinPlaylist(id, name, path) {
    state.view = "builtin-" + id;
    setStageHeader(name, "Local IPTV channels", false);
    setLoading(true, "Loading " + name + "…");
    try {
      renderChannels(await fetchM3U(path, name));
    } catch (e) {
      showToast("Couldn't load \u201c" + name + "\u201d. Check that the stream server is reachable.");
      renderChannels([]);
    } finally { setLoading(false); }
  }

  async function loadCustomPlaylist(playlist) {
    state.view = "custom";
    setStageHeader(playlist.name, playlist.url, false);
    setLoading(true, "Loading " + playlist.name + "…");
    try {
      renderChannels(await fetchM3U(playlist.url));
    } catch (e) {
      showToast("Couldn't load \u201c" + playlist.name + "\u201d. Check the URL and try again.");
      renderChannels([]);
    } finally { setLoading(false); }
  }

  /* ---------------------------------------------------------------------
     Nav rail population
     --------------------------------------------------------------------- */
  function buildCategoryNav() {
    const frag = document.createDocumentFragment();
    BUILTIN_PLAYLISTS.forEach(([id, name, path]) => {
      const item = document.createElement("div");
      item.className = "nav-item"; item.tabIndex = 0;
      item.innerHTML = '<span class="dot"></span>' + name;
      item.addEventListener("click", () => { setActiveNav(item); loadBuiltinPlaylist(id, name, path); });
      frag.appendChild(item);
    });
    CATEGORIES.forEach(([id, name]) => {
      const item = document.createElement("div");
      item.className = "nav-item"; item.tabIndex = 0;
      item.innerHTML = '<span class="dot"></span>' + name;
      item.addEventListener("click", () => { setActiveNav(item); loadCategory(id, name); });
      frag.appendChild(item);
    });
    el.categoryList.appendChild(frag);
  }

  async function buildCountryNav() {
    try {
      const res = await fetch(API_BASE + "/countries.json");
      if (!res.ok) throw new Error("HTTP " + res.status);
      const countries = await res.json();
      countries.sort((a, b) => a.name.localeCompare(b.name));
      const frag = document.createDocumentFragment();
      countries.forEach((c) => {
        const item = document.createElement("div");
        item.className = "nav-item"; item.tabIndex = 0;
        item.innerHTML = '<span class="dot"></span>' + (c.flag || "") + "&nbsp;&nbsp;" + c.name;
        item.addEventListener("click", () => { setActiveNav(item); loadCountry(c.code, c.name); });
        frag.appendChild(item);
      });
      el.countryList.appendChild(frag);
    } catch (e) {
      // Non-fatal: country browsing just won't populate if this fails.
    }
  }

  function buildCustomPlaylistNav() {
    el.customPlaylistList.innerHTML = "";
    const playlists = readLS(LS_PLAYLISTS);
    playlists.forEach((p) => {
      const row = document.createElement("div");
      row.className = "playlist-row";
      const item = document.createElement("div");
      item.className = "nav-item"; item.tabIndex = 0;
      item.innerHTML = '<span class="dot"></span>' + p.name;
      item.addEventListener("click", () => { setActiveNav(item); loadCustomPlaylist(p); });
      const remove = document.createElement("div");
      remove.className = "playlist-remove"; remove.tabIndex = 0; remove.title = "Remove playlist";
      remove.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      remove.addEventListener("click", (e) => {
        e.stopPropagation();
        const updated = readLS(LS_PLAYLISTS).filter((x) => x.id !== p.id);
        writeLS(LS_PLAYLISTS, updated);
        buildCustomPlaylistNav();
        showToast("Removed \u201c" + p.name + "\u201d");
      });
      row.appendChild(item); row.appendChild(remove);
      el.customPlaylistList.appendChild(row);
    });
  }

  /* ---------------------------------------------------------------------
     Add-playlist modal
     --------------------------------------------------------------------- */
  function openModal() {
    el.modalBackdrop.style.display = "flex";
    el.playlistUrlInput.value = ""; el.playlistNameInput.value = "";
    el.playlistUrlInput.focus();
  }
  function closeModal() { el.modalBackdrop.style.display = "none"; el.addPlaylistBtn.focus(); }

  el.addPlaylistBtn.addEventListener("click", openModal);
  el.modalCancel.addEventListener("click", closeModal);
  el.modalSave.addEventListener("click", async () => {
    const url = el.playlistUrlInput.value.trim();
    const name = el.playlistNameInput.value.trim() || "My Playlist";
    if (!url) { showToast("Paste a playlist URL first."); return; }
    setLoading(true, "Checking playlist…");
    try {
      const channels = await fetchM3U(url); // validate it parses before saving
      const playlists = readLS(LS_PLAYLISTS);
      const entry = { id: "pl_" + Date.now(), name, url };
      playlists.push(entry);
      writeLS(LS_PLAYLISTS, playlists);
      buildCustomPlaylistNav();
      closeModal();
      setStageHeader(name, url, false);
      state.view = "custom";
      renderChannels(channels);
      showToast("Added \u201c" + name + "\u201d \u2014 " + channels.length + " channels");
    } catch (e) {
      showToast("Couldn't load that playlist. Check the URL and that it's a public M3U file.");
    } finally {
      setLoading(false);
    }
  });

  /* ---------------------------------------------------------------------
     Player
     --------------------------------------------------------------------- */
  let hls = null;
  let dialBuffer = "";
  let dialTimer = null;

  function digitFromKey(e) {
    if (e.key && e.key.length === 1 && e.key >= "0" && e.key <= "9") return e.key;
    const code = e.keyCode;
    if (code >= 48 && code <= 57) return String(code - 48);
    if (code >= 96 && code <= 105) return String(code - 96);
    return null;
  }

  function maxDialDigits() {
    return Math.max(1, Math.min(4, String(state.stations.length).length));
  }

  function updateDialDisplay() {
    if (!dialBuffer) {
      el.channelNumber.classList.remove("dialing");
      if (state.currentIndex >= 0) {
        el.channelNumber.textContent = String(state.currentIndex + 1).padStart(3, "0");
      }
      return;
    }
    el.channelNumber.classList.add("dialing");
    el.channelNumber.textContent = dialBuffer.padStart(3, "\u00b7");
  }

  function clearDial() {
    clearTimeout(dialTimer);
    dialTimer = null;
    dialBuffer = "";
    updateDialDisplay();
  }

  function commitDial() {
    clearTimeout(dialTimer);
    dialTimer = null;
    if (!dialBuffer) return;
    const typed = dialBuffer;
    const num = parseInt(dialBuffer, 10);
    dialBuffer = "";
    updateDialDisplay();
    if (!num || num < 1 || num > state.stations.length) {
      showToast("No channel " + typed + " in this list (1\u2013" + state.stations.length + ").");
      return;
    }
    playIndex(num - 1, { zap: true });
  }

  function appendDialDigit(d) {
    showOverlay();
    clearTimeout(dialTimer);
    dialBuffer += d;
    const max = maxDialDigits();
    if (dialBuffer.length > max) dialBuffer = dialBuffer.slice(-max);
    updateDialDisplay();
    el.playerView.focus();
    dialTimer = setTimeout(commitDial, 1500);
  }

  function openPlayer(list, index) {
    state.currentIndex = index;
    state.stations = filterHidden(list);
    document.body.classList.add("player-open");
    el.playerView.classList.add("active");
    el.playerView.focus();
    playIndex(index);
  }

  function closePlayer() {
    document.body.classList.remove("player-open");
    el.playerView.classList.remove("active");
    clearDial();
    stopStream();
    if (state.stations.length) renderChannels(state.stations);
    // Return focus to the grid card that was playing, if still present.
    const card = document.querySelector('.card[data-uid="' + (state.current ? cssEscape(state.current.uid) : "") + '"]');
    (card || document.querySelector('.nav-item.active') || document.body).focus();
  }

  function cssEscape(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, "_"); }

  function stopStream() {
    try { el.video.pause(); el.video.removeAttribute("src"); el.video.load(); } catch (e) {}
    if (hls) { hls.destroy(); hls = null; }
  }

  function usesNativePipeline() {
    return !!(el.video.canPlayType("application/vnd.apple.mpegurl") ||
      el.video.canPlayType("application/vnd.apple.mpegURL"));
  }

  function updatePlayerMeta(ch, index) {
    if (!dialBuffer) {
      el.channelNumber.textContent = String(index + 1).padStart(3, "0");
      el.channelNumber.classList.remove("dialing");
    }
    el.playerName.textContent = ch.name;
    el.playerMeta.textContent = [ch.group, ch.country].filter(Boolean).join(" · ") || "Live channel";
    el.playerLogo.innerHTML = "";
    if (ch.logo) {
      const img = document.createElement("img");
      img.src = ch.logo;
      img.onerror = () => { img.remove(); el.playerLogo.textContent = initials(ch.name); };
      el.playerLogo.appendChild(img);
    } else {
      el.playerLogo.textContent = initials(ch.name);
    }
    el.playerStatus.textContent = "Connecting…";
    el.playerStatus.classList.remove("live");
    updatePlayerActions();
  }

  function updatePlayerActions() {
    if (!state.current) return;
    const fav = isFavorite(state.current.uid);
    el.playerFav.classList.toggle("is-fav", fav);
    el.playerFavLabel.textContent = fav ? "Remove from Favorites" : "Add to Favorites";
  }

  function toggleFavoriteCurrent() {
    if (!state.current) return;
    const nowFav = toggleFavorite(state.current);
    updatePlayerActions();
    showToast(nowFav ? "Added to Favorites" : "Removed from Favorites");
  }

  function hideCurrentChannel() {
    const ch = state.current;
    if (!ch) return;
    hideChannelUid(ch.uid);
    const name = ch.name;
    state.stations = state.stations.filter((c) => c.uid !== ch.uid);
    if (!state.stations.length) {
      showToast("Hidden \u201c" + name + "\u201d. No more channels in this list.");
      closePlayer();
      renderChannels([]);
      return;
    }
    const idx = state.currentIndex >= state.stations.length ? 0 : state.currentIndex;
    playIndex(idx, { zap: true });
    showToast("Hidden \u201c" + name + "\u201d");
  }

  function startStream(src, zap) {
    const isHls = /\.m3u8?($|\?)/i.test(src);
    const useHlsJs = isHls && !usesNativePipeline() && window.Hls && Hls.isSupported();

    // Channel surf: swap the source in place. Tearing down the element makes
    // webOS TV shrink playback into the corner PiP window.
    if (zap && useHlsJs && hls) {
      hls.loadSource(src);
      el.video.play().catch(() => {});
      return;
    }
    if (zap && !useHlsJs) {
      if (hls) { hls.destroy(); hls = null; }
      el.video.src = src;
      el.video.play().catch(() => {});
      return;
    }

    stopStream();
    if (useHlsJs) {
      hls = new Hls({ maxBufferLength: 20 });
      hls.loadSource(src);
      hls.attachMedia(el.video);
      hls.on(Hls.Events.ERROR, (evt, data) => { if (data.fatal) handleStreamError(); });
    } else {
      el.video.src = src;
    }
    el.video.play().catch(() => {});
  }

  function playIndex(index, options) {
    const opts = options || {};
    const list = state.stations;
    if (!list.length) return;
    const i = ((index % list.length) + list.length) % list.length;
    const zap = !!opts.zap;
    state.currentIndex = i;
    const ch = list[i];
    state.current = ch;

    updatePlayerMeta(ch, i);
    startStream(ch.url, zap);

    pushRecent(ch);
    if (!zap) showOverlay();
    el.playerView.focus();
  }

  function handleStreamError() {
    el.playerStatus.textContent = "Unavailable";
    showToast("Couldn't play \u201c" + (state.current ? state.current.name : "this channel") + "\u201d. Try another.");
  }

  el.video.addEventListener("playing", () => {
    el.playerStatus.innerHTML = '<span class="pulse"></span> Live';
    el.playerStatus.classList.add("live");
  });
  el.video.addEventListener("waiting", () => { el.playerStatus.textContent = "Buffering…"; });
  el.video.addEventListener("error", handleStreamError);

  function showOverlay() {
    el.playerOverlay.classList.remove("hidden");
  }
  function hideOverlay() {
    el.playerOverlay.classList.add("hidden");
    el.playerView.focus();
  }
  function toggleOverlay() {
    if (el.playerOverlay.classList.contains("hidden")) showOverlay();
    else hideOverlay();
  }

  function focusPlayerButtons(direction) {
    const buttons = Array.from(document.querySelectorAll(".player-actions .pbtn"));
    if (!buttons.length) return;
    const current = document.activeElement;
    const idx = buttons.indexOf(current);
    if (idx < 0) {
      buttons[direction === "left" ? buttons.length - 1 : 0].focus();
      return;
    }
    const next = direction === "left" ? idx - 1 : idx + 1;
    if (next >= 0 && next < buttons.length) buttons[next].focus();
  }

  el.playerPrev.addEventListener("click", () => playIndex(state.currentIndex - 1, { zap: true }));
  el.playerNext.addEventListener("click", () => playIndex(state.currentIndex + 1, { zap: true }));
  el.playerFav.addEventListener("click", toggleFavoriteCurrent);
  el.playerHide.addEventListener("click", hideCurrentChannel);

  /* ---------------------------------------------------------------------
     Spatial navigation (D-pad) — shared geometry-based approach
     --------------------------------------------------------------------- */
  function getFocusable() {
    return Array.from(document.querySelectorAll("[tabindex]")).filter((n) => {
      if (n.offsetParent === null && n !== el.playerView) return false;
      const style = getComputedStyle(n);
      return style.display !== "none" && style.visibility !== "hidden";
    });
  }
  function rectCenter(node) { const r = node.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
  function moveFocus(direction) {
    const all = getFocusable().filter((n) => n !== el.playerView);
    const current = document.activeElement;
    if (!current || !all.includes(current)) { if (all[0]) all[0].focus(); return; }
    const cur = rectCenter(current);
    let best = null, bestScore = Infinity;
    for (const node of all) {
      if (node === current) continue;
      const c = rectCenter(node);
      const dx = c.x - cur.x, dy = c.y - cur.y;
      let ok = false, primary = 0, cross = 0;
      if (direction === "right") { ok = dx > 4; primary = dx; cross = Math.abs(dy); }
      else if (direction === "left") { ok = dx < -4; primary = -dx; cross = Math.abs(dy); }
      else if (direction === "down") { ok = dy > 4; primary = dy; cross = Math.abs(dx); }
      else if (direction === "up") { ok = dy < -4; primary = -dy; cross = Math.abs(dx); }
      if (!ok) continue;
      const score = primary + cross * 2.2;
      if (score < bestScore) { bestScore = score; best = node; }
    }
    if (best) best.focus();
  }

  document.addEventListener("keydown", (e) => {
    const inPlayer = el.playerView.classList.contains("active");
    const isInput = document.activeElement && document.activeElement.tagName === "INPUT";

    if (inPlayer) {
      const digit = digitFromKey(e);
      if (digit !== null) {
        appendDialDigit(digit);
        e.preventDefault();
        return;
      }

      const onBtn = document.activeElement && document.activeElement.classList.contains("pbtn");
      const overlayVisible = !el.playerOverlay.classList.contains("hidden");
      switch (e.keyCode) {
        case 37:
          if (dialBuffer) { clearDial(); e.preventDefault(); break; }
          if (overlayVisible) { focusPlayerButtons("left"); e.preventDefault(); }
          break;
        case 39:
          if (dialBuffer) { clearDial(); e.preventDefault(); break; }
          if (overlayVisible) { focusPlayerButtons("right"); e.preventDefault(); }
          break;
        case 38:
          if (dialBuffer) clearDial();
          playIndex(state.currentIndex - 1, { zap: true }); e.preventDefault(); break;
        case 40:
          if (dialBuffer) clearDial();
          playIndex(state.currentIndex + 1, { zap: true }); e.preventDefault(); break;
        case 13: case 23:
          if (dialBuffer) { commitDial(); e.preventDefault(); break; }
          if (onBtn) { document.activeElement.click(); e.preventDefault(); }
          else { toggleOverlay(); e.preventDefault(); }
          break;
        case 461: case 8:
          if (dialBuffer) { clearDial(); e.preventDefault(); }
          else { closePlayer(); e.preventDefault(); }
          break;
        case 415: el.video.play(); break;
        case 19: el.video.pause(); break;
        case 413: closePlayer(); break;
        default: break;
      }
      return;
    }

    switch (e.keyCode) {
      case 37: if (!isInput) { moveFocus("left"); e.preventDefault(); } break;
      case 39: if (!isInput) { moveFocus("right"); e.preventDefault(); } break;
      case 38: moveFocus("up"); e.preventDefault(); break;
      case 40: moveFocus("down"); e.preventDefault(); break;
      case 13: case 23:
        if (document.activeElement && document.activeElement !== document.body) document.activeElement.click();
        break;
      case 461: // webOS Back
        if (el.modalBackdrop.style.display === "flex") { closeModal(); e.preventDefault(); }
        else if (state.view !== "search") { enterSearchView(); e.preventDefault(); }
        break;
      case 8:
        if (!isInput) {
          if (el.modalBackdrop.style.display === "flex") { closeModal(); e.preventDefault(); }
          else if (state.view !== "search") { enterSearchView(); e.preventDefault(); }
        }
        break;
      default: break;
    }
  });

  // Favorites and hide-from-list are available from the player action bar.

  /* ---------------------------------------------------------------------
     Boot
     --------------------------------------------------------------------- */
  function fitViewport() {
    // webOS TV renders video on a separate plane; body transforms break placement.
    if (/webOS/i.test(navigator.userAgent)) return;
    const scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080, 1);
    document.body.style.transform = scale < 1 ? "scale(" + scale + ")" : "";
  }
  fitViewport();
  window.addEventListener("resize", fitViewport);

  document.querySelectorAll(".nav-item[data-nav]").forEach((item) => {
    item.addEventListener("click", () => {
      const view = item.dataset.nav;
      if (view === "search") enterSearchView();
      else if (view === "favorites") loadFavorites();
      else if (view === "recent") loadRecent();
    });
  });

  buildCategoryNav();
  buildCountryNav();
  buildCustomPlaylistNav();
  enterSearchView();
  document.querySelector('[data-nav="search"]').focus();

})();
