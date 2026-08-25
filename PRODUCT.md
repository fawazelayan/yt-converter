# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Existing codebase answers this: Node + Express 4 serving plain static files (`public/index.html`, `style.css`, `app.js`) with no build step, no bundler, and no framework. Media work is done by a bundled `yt-dlp.exe` and `ffmpeg-static`. Launched by `start.bat` → `node server.js` → `http://localhost:3000`.

The **deploy target is an open conflict** — see Capabilities and Constraints.

## Users

- **Primary:** the project owner, using the tool for themselves. Confirmed: not a public service, no anonymous audience, no marketing or SEO surface.
- **Secondary:** a small circle of friends the owner may share access with. "For personal use and for friends, nothing more."

There is no admin role, no accounts, no multi-tenant concern. Anything the interface asks of the user can assume one person at a time who already knows what the tool is for.

## Product Purpose

Turn a YouTube URL into a saved file on the user's device — an **MP3** (audio) or an **MP4** (video). That is the job, confirmed directly by the owner over the alternatives.

Success is a correct file in the user's downloads folder with the fewest steps and no ambiguity about what is about to be downloaded or how large it will be.

## Positioning

A personal-scale downloader that does not behave like the public converter sites it replaces: no ads, no interstitials, no fake download buttons, no upsells, no upload of the user's data anywhere. It talks to `yt-dlp` and `ffmpeg` directly, so it can show real available formats, real quality tiers, and a real estimated file size *before* the user commits to a download.

## Operating Context

- Today the tool runs entirely on the owner's Windows PC. `start.bat` starts the server and opens the browser automatically; the browser is the whole interface.
- Downloads are produced into `downloads_temp/` and then streamed to the browser as a file download.
- Work is short-session and repetitive: paste a link, pick a format, save, often several times in a row.
- Recent downloads are remembered in browser `localStorage` (`ytdownload_history`) — there is no server-side database or user record of any kind.
- The owner wants to use this from a **phone as well as a PC**. Today it is PC-only in every sense: reachable only at `localhost`, and laid out for a mouse.

## Capabilities and Constraints

**Confirmed capabilities (built and working):**

- `POST /api/info` — resolves a YouTube URL (including Shorts) to title, channel, views, duration, dimensions, thumbnail, and the available format list.
- MP3 export at selectable audio quality; MP4 export at selectable video quality.
- Per-option **file size estimates** shown before download.
- A segment **trimmer**: dual range sliders plus typed `00:00:00` start/end fields, with quick presets (full / first 30s / first 60s).
- An in-page video preview player used to find trim points ("Set Start" / "Set End" at the current playhead).
- Live progress via Server-Sent Events (`GET /api/progress/:jobId`) driving a modal with percentage and status.
- Local download history with clear-list.

**Binding constraints:**

- **Zero-install is binding.** No build step, no bundler, no framework compile. Plain files served directly must keep working. (Confirmed by the owner.)
- Neither the current name nor the current visual identity was made binding — see Brand Commitments.
- Windows-only was *not* declared binding.

**Completed scope change (shipped 2026-08-25):**

- The "Video Cropper" studio was **reduced to a trimmer**. The owner needs trimming only. The crop box, 8 resize handles, aspect-ratio presets (9:16 / 1:1 / 4:5 / 16:9 / 21:9 / free), crop scale slider, rule-of-thirds grid, and pixel-coordinate fine-tuning were removed.
- Format is now a binary choice — audio or video — and trimming is an optional modifier that applies to both, rather than a third mode. Trim start/end, the preview player, and size estimation stayed.
- Consequently `crop` is no longer a mode at all; MP4 leads and MP3 sits beside it.

**Delivery constraints discovered while building (do not re-litigate without testing):**

- A download that is *not* trimmed streams straight through to the browser with no temp file and no progress bar. A trimmed one has to be fetched and re-encoded first, so it runs as a job with progress. These are two genuinely different paths and the interface says so.
- yt-dlp cannot run post-processors while writing to stdout. Piped audio arrives as WebM/Opus and piped video as MPEG-TS, so ffmpeg does the container work in-stream: real MP3 for audio, fragmented MP4 for video.
- MPEG-TS can only carry H.264 + AAC, so the streaming path pins the **codec**, not the container. `ext=mp4` is not sufficient — YouTube serves AV1 and VP9 inside MP4 and those tracks are dropped in transit.
- Because of that, **1080p is the honest ceiling for MP4**. YouTube publishes 1440p and 2160p only as VP9/AV1. The quality list is built from what the video actually has, capped at 1080p, so a 4K option that quietly returns 1080p is never shown. Restoring 4K would mean a re-encode on the job path, which is a real decision, not an oversight.

**OPEN CONFLICT — deployment (unresolved, do not invent an answer):**

The owner states the target is **GitHub Pages**, for personal and friend use. GitHub Pages serves static files only — it cannot run Node, Express, `yt-dlp`, or `ffmpeg`, and it cannot execute the bundled Windows `yt-dlp.exe`. Every capability listed above is server-side. The app as built therefore cannot function on GitHub Pages.

This is recorded as an open product decision. Future work must resolve it explicitly with the owner rather than assuming either side. It also means the following are currently **undecided**: the real hosting target, whether a gate/auth exists, whether friends get access by URL or by running their own copy, and whether Windows-only remains acceptable.

## Brand Commitments

None binding. The owner did not mark the name, look, or fonts as fixed.

For the record, the current implementation carries: the name **YT Downloader** (the "& Video Cropper" half was dropped when the cropper was), a dark interface built on one red accent plus neutrals, Outfit for text, and JetBrains Mono for timecodes and file sizes. Icons are an authored SVG sprite at a single stroke weight. There is no logo file, no legal entity, and no brand asset beyond what is written in the CSS.

## Evidence on Hand

None. There are no users beyond the owner and friends, no testimonials, no metrics, no press, no case studies, no pricing, and no licensing story. Future work must not fabricate any of these, and must not add social proof, user counts, ratings, or "trusted by" claims to any surface.

The only real assets are the codebase itself and the bundled binaries.

## Product Principles

1. **The download path is the product.** MP3 and MP4 lead. Anything that lengthens the paste → choose → save path has to earn it.
2. **Zero-install or it doesn't ship.** A change that requires a build step, a bundler, or a compile is the wrong change.
3. **Show the cost before the commit.** Format, quality, duration, and estimated size are known before the user clicks download — keep it that way.
4. **Trim, don't edit.** This is not an editor. Cutting a segment is the only manipulation in scope.
5. **Personal scale, stated honestly.** No invented audience, no fake proof, no marketing posture. One person and a few friends.

## Accessibility & Inclusion

No formal standard was established as a requirement.

One concrete, owner-stated need is **partly met**: the interface must work on a phone. A 620px breakpoint now reflows the form, quality grid, transport, and time fields, and enlarges the scrubber handles for thumbs. This has not been verified on a real device or in a browser, so treat it as written but untested. Reaching the server from a phone at all remains blocked on the hosting decision above.
