# AR Wall Portal

Web AR (no app install). Point a phone at a printed poster, wall graphic or billboard and the print
becomes a window: video plays *behind* the wall, and because it really sits in 3D space behind the
print, it shifts with correct parallax as you move.

Tracking uses the **open-source 8th Wall engine** (`@8thwall/engine` 0.1.0, MIT licence, image targets only).
Rendering uses three.js r160.

## Quick start

```bash
npm install            # only needed for building image targets
npm run targets        # builds image-targets/ from the trigger in config.json
npm start              # serves on http://localhost:8080
```

* Desktop preview (no camera, move the mouse): `http://localhost:8080/?preview`
* On a phone the page must be served over **HTTPS** (camera access). Deploy the folder as a static
  site (Vercel, Netlify, GitHub Pages, S3...) or tunnel your local server (e.g. `npx localtunnel --port 8080`).
* Preview options: `?preview&reveal=open` skips the shatter; `?reveal=auto` breaks the print open without a tap.

## The experience (mirrors the publication demo)

1. Intro card with the poster thumbnail and **Continue**.
2. Camera opens with a "Find and scan the poster" guide.
3. On lock-on: **"Tap the screen to explore"**.
4. Tap: cracks race out from the centre, the print breaks into thick paper shards that burst towards
   you, revealing a torn hole with a white paper edge. The video plays inside from its first frame
   (the poster photo is that same first frame, so the hand-off is seamless).

## Using your own print and video

1. Put your files in `assets/` and edit `config.json`:
   * `trigger`: the print artwork (JPG/PNG, 2000 px+ on the long side is best).
   * `printWidthMeters`: real printed width. Only used to turn the depths below into real-world distances.
   * `portal.opening`: where the hole is, as `[x, y, width, height]` fractions of the artwork measured from
     the top-left. `[0, 0, 1, 1]` makes the whole print a window.
   * `portal.shape`: `"torn"` (jagged hole, default) or `"rect"`. `portal.torn` tunes it:
     `inset` (border kept inside the opening), `roughness`, `squareness` (0 = oval, 1 = square), `seed`
     (change for a different tear).
   * `portal.paperEdgeColor` / `paperEdgeMeters`: the white torn fringe. `revealDepthMeters` / `revealColor`:
     thickness of the paper/wall seen inside the hole.
   * `reveal.trigger`: `"tap"` (default), `"auto"`, or `"open"` (no shatter). `reveal.effect`: `"shatter"` or `"none"`.
   * `particles.count`: floating specks inside the portal for extra depth (0 = off).
   * `portal.mask` (optional): PNG the same size as the artwork; white/opaque = hole. Use it for
     non-rectangular openings (arches, cut-out lettering...).
   * `portal.overlay` (optional): transparent PNG drawn on the print surface in front of the hole
     (window frame, glass glare, logo).
   * `video.src`: your video (H.264 MP4). `video.depthMeters` is how far behind the wall it sits.
2. Run `npm run targets` again whenever the trigger image changes.

## How the parallax works (and the options)

A flat video has no depth of its own, so the depth comes from where we place things:

| Mode | What it is | Best for |
|---|---|---|
| **Video at depth** (default) | Video plane set back behind a "reveal" (the wall thickness), with an invisible wall hiding everything except the hole | Any footage. Reliable, looks like a real window. |
| **+ Depth layers** (`layers`) | Transparent PNGs (or videos) at different depths in front of the main video: foliage, a window frame, foreground objects | Adding strong near/far parallax cheaply |
| **Depth map** (`video.depthMap`) | Video mesh pushed towards the viewer by a depth map; `"sbs"` = side-by-side video (colour left, greyscale depth right, white = near) | Footage with clear depth structure. Depth videos can be generated with tools such as Depth Anything. Can stretch at hard depth edges. |

## Big prints: walls and billboards

* 8th Wall image targets are always 3:4 crops. `npm run targets` covers the artwork with overlapping 3:4
  crops (largest that fit, plus smaller "close-range" crops) up to 10 targets. Each knows where it sits on
  the print, so the portal stays locked whether you see the whole billboard or just part of a wall.
  Tune with `targetOptions` (`closeRange`, `closeRangeSize`, `overlap`).
* Physical size does not affect tracking. What matters is how much of the camera frame the print fills.
  For a billboard viewed from far away, keep high-contrast detail across the artwork, and avoid large flat
  areas and repeating patterns.
* Glossy or backlit prints can glare. Matte finishes track best.

## Files

* `index.html`, `js/app.js`: AR app and desktop preview
* `js/portal.js`: builds the portal (occluder, reveal, video, layers, overlay)
* `js/targets.js`: target crop layout shared by the app and the build script
* `tools/make-targets.mjs`: builds 8th Wall image targets (uses `@8thwall/image-target-cli`)
* `vendor/8thwall`: open-source 8th Wall engine (MIT, see LICENSE). `vendor/three`: three.js (MIT)

`assets/beach/poster.jpg` is the framed marker built from the first frame of the beach clip; `assets/beach/video.mp4`
is the clip re-encoded to 720p H.264 for fast mobile loading.
