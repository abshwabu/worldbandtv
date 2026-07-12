# WorldBand TV — LG webOS IPTV App

The video companion to WorldBand Radio. Browse thousands of free, publicly
available live TV channels sourced from [iptv-org/iptv](https://github.com/iptv-org/iptv),
by category or country, add your own playlist URLs, save favorites, and
channel-surf with the remote.

## What's inside

```
worldbandtv/
├── appinfo.json      webOS app manifest
├── index.html         app shell (browse grid + full-screen player)
├── css/styles.css     visual design (shared token family with WorldBand Radio)
├── js/app.js           M3U parsing, playlist fetching, remote navigation, player
├── js/hls.min.js       bundled HLS.js (fallback for browsers without native HLS)
├── fonts/               bundled Space Grotesk + Inter
└── icons/               app icon, large icon, splash screen
```

## Where the channels come from

- **Categories & countries** load on demand from iptv-org's pre-built,
  GitHub Pages–hosted M3U playlists (e.g.
  `https://iptv-org.github.io/iptv/categories/sports.m3u`,
  `https://iptv-org.github.io/iptv/countries/et.m3u`), so the app never
  downloads more than what's currently being browsed.
- **Search** fetches iptv-org's full `index.m3u` once per session (this is a
  larger file covering their whole catalog) and caches it in memory.
- **Country names/flags** come from `https://iptv-org.github.io/api/countries.json`.
- **Your own playlists**: use "Add playlist URL" in the left rail to paste
  any public M3U/M3U8 link. It's validated by fetching and parsing it before
  saving, then stored in the TV's local storage under "My Playlists" for
  next time — including in front of the built-in categories, if you'd
  rather lead with your own list.
- The `xxx` (adult) category from iptv-org is intentionally never listed,
  and every parsed playlist — built-in or user-supplied — is filtered
  through a simple name/group check that drops anything matching
  adult-content keywords before it ever reaches the grid.

## Try it in a browser first

```bash
cd worldbandtv
python3 -m http.server 8080
# open http://localhost:8080
```

Arrow keys move focus, Enter activates, Backspace acts as Back. Inside the
player: Up/Down change channel within the list you opened it from, Enter
shows/hides the info overlay or pauses, Backspace exits to browsing.

Real LG TVs decode HLS (`.m3u8`) streams natively through the platform's own
media pipeline, so most channels will just work. Desktop Chrome doesn't
support HLS natively, which is why `hls.js` is bundled as a fallback for
testing in a regular browser.

## Packaging for a real LG TV

Same flow as WorldBand Radio:

```bash
npm install -g @webosose/ares-cli
ares-setup-device                                  # register your TV (Dev Mode required)
ares-package worldbandtv/                           # → com.bina.worldbandtv_1.0.0_all.ipk
ares-install -d <device-name> com.bina.worldbandtv_1.0.0_all.ipk
ares-launch -d <device-name> com.bina.worldbandtv
ares-log -d <device-name> -f                         # watch logs while testing
```

Change `id` and `vendor` in `appinfo.json` before shipping this anywhere —
`com.bina.worldbandtv` is a placeholder for testing.

## Known limitations

- **Public, unmoderated streams.** iptv-org is a community-maintained index
  of links that broadcasters have made publicly accessible; it doesn't host
  video itself and doesn't guarantee a channel's uptime, quality, or
  regional licensing. Some links will be dead, geo-blocked, or slow — that's
  inherent to the source, not something this app can fix. The
  [project's own README](https://github.com/iptv-org/iptv) covers how they
  handle removal requests if you ever need to report a link.
- **Streams that require a custom Referer or User-Agent header** (a handful
  of entries in iptv-org's data specify these) won't play, since browsers
  don't allow web apps to override those headers for cross-origin media
  requests. The app skips straight to an error toast for those rather than
  attempting a workaround.
- **No EPG (program guide).** iptv-org publishes one separately via
  `iptv-org/epg`; wiring that in would be a reasonable next step if you want
  a "what's on now" view.
- The NSFW keyword filter is a basic safety net, not a guarantee — it
  catches channels whose name or category is explicitly labeled, not
  everything a stricter moderation pass might catch.
