# Squat Depth

A web app that watches your squat from the side through the iPhone camera and plays a **ding the moment your knee angle reaches your target depth**. One ding per rep. A low buzz if you cut a rep short.

Everything runs in Safari on the phone. No server, no account, no build step, nothing uploaded: the video never leaves the device.

- `index.html` is the whole app (HTML, CSS, JS).
- `vendor/` holds the MediaPipe pose library and models (about 40 MB), so the app loads from your own site instead of depending on a CDN. If `vendor/` is missing, the app falls back to jsDelivr and Google's model storage automatically.
- `tests/run-tests.mjs` unit-tests the rep logic.
- `serve.py` is a tiny local server for testing.

## Put it on your iPhone (GitHub Pages, free)

The iPhone camera only works on HTTPS pages. GitHub Pages gives you HTTPS for free.

1. Sign in at github.com and create a new **public** repository, for example `squat-depth`. Don't add a README or licence there.
2. In Terminal, from this folder:

   ```bash
   git init -b main
   git add .
   git commit -m "Squat depth checker"
   git remote add origin https://github.com/YOUR-USERNAME/squat-depth.git
   git push -u origin main
   ```

   No git? On the repository page choose **Add file → Upload files**, drag in everything from this folder (including `vendor/` and `.nojekyll`), and commit.
3. On the repository page: **Settings → Pages**. Under "Build and deployment" set **Source: Deploy from a branch**, **Branch: main**, folder **/ (root)**, then **Save**.
4. Wait about a minute, then open `https://YOUR-USERNAME.github.io/squat-depth/` in Safari on the iPhone.
5. Optional but worth it: **Share → Add to Home Screen**. Launched from the home screen it runs full screen with no Safari bars.

To update later: edit, `git commit -am "..."`, `git push`.

## Test locally

**On the Mac (webcam or a video file):**

```bash
python3 serve.py
```

Open `http://localhost:8000/`. `localhost` counts as a secure page, so the Mac's webcam works.

**On the iPhone, over your Wi-Fi, with the real camera:**

```bash
python3 serve.py --https
```

It prints an address like `https://192.168.x.x:8443/`. Open it in Safari on the iPhone (same Wi-Fi). The certificate is self-signed, so Safari warns once: tap **Show Details → visit this website → Visit Website**. The script creates the certificate with `openssl` on first run and keeps it in `.cert/`.

If macOS asks whether Python may accept incoming connections, allow it.

**Test mode (no camera):** tap **Test with video** and pick a clip from Photos or Files. The same pipeline runs on the file, so you can film a set at the gym and replay it at home while you tune the target. Add `?video=clip.mp4` to the address to skip the picker for a file sitting next to `index.html`.

## At the gym

1. Phone on the tripod **at your side**, about hip height, 2 to 3 m away, **landscape**. From behind, the knee angle can't be seen.
2. Stand sideways to the camera with your whole body in frame, at the top and at the bottom.
3. Tap **Start camera**. Wait for the green **LOCK** pill and the thick line on your camera-side leg.
4. Do one unloaded rep and listen for the ding before you load the bar.
5. Phone speaker, volume up. **No Bluetooth.**

The screen shows the live knee angle, good reps (big number), shallow reps, and the lowest angle of your last rep.

Things that confuse it: someone walking between you and the phone, another person closer to the camera than you (it tracks one body, the most prominent one), and the knee disappearing behind the Smith machine upright. Move the tripod a little forward or back so the upright doesn't sit on your knee. In poor light or very baggy clothes, try **Full model** in Settings.

## Settings

All saved on the phone.

| Setting | Default | What it does |
|---|---|---|
| Target depth | 90° | Knee angle that earns the ding. 60 to 130. Lower is deeper. |
| Standing / re-arm | 160° | You must come back above this to finish the rep and arm the next ding. Lower it if you don't lock out. |
| Sound | on | Ding and buzz. The green screen flash stays either way. |
| Buzz on shallow reps | on | Low buzz and "TOO SHALLOW" when a rep misses the target. |
| Anticipation | on | Dings one frame early when you are about to cross the target. |
| Extra anticipation lead | 0 ms | Predict further ahead (up to 150 ms). See the latency section before raising it. |
| Performance mode | off | No skeleton, no live angle. Rep counter, lock pill and debug line only. |
| Full model | off | More accurate, slower per frame. |
| Debug line | on | fps and timing at the bottom of the screen. |

## How a rep is judged

The knee angle is the interior angle between hip, knee and ankle in the image (180° is a straight leg). The app uses whichever leg the camera sees better and re-checks that every 3 seconds, never in the middle of a rep.

| State | Rule |
|---|---|
| Not armed | Until you've been seen standing (above 160°). Walking into frame in a crouch won't ding. |
| Standing | Angle above 160°. |
| Descending | Angle drops below 150°. |
| **Depth: ding** | First frame at or below the target. Fires once, immediately. |
| Rep counted | Back above 160° after a ding. Then it re-arms. |
| Shallow | Went below 130°, never reached the target, returned above 160°. |

A second ding in the same rep is impossible: after the ding nothing can fire until you stand back up past 160°. The 150/160 gap stops wobble at the top from starting phantom reps. A dip that stays above 130° is ignored.

Every threshold is a named constant at the top of the `<script id="core">` block in `index.html`.

## Latency: what the app does, and what it can't fix

The ding can't be truly instant. Between your knee crossing the target and the sound leaving the speaker there are four delays:

| Stage | Roughly | Notes |
|---|---|---|
| Camera | 30 to 70 ms | Exposure, sensor read-out, image processing, delivery to Safari. **Estimate.** Safari doesn't expose capture time to web pages, so the app can't measure this part. |
| Waiting for a frame | half a frame on average | About 8 ms at 60 fps, 17 ms at 30 fps. The crossing happens between frames. |
| Pose inference | 14 to 16 ms | **Measured** on an iPhone 17 Pro, lite model, GPU, in test mode. |
| Audio out | 5 to 25 ms | Safari reported 3 ms of buffer on the same phone; the speaker hardware adds some it doesn't report. **Estimate.** |

So expect something like **70 to 130 ms** from the real movement to the sound with the live camera, before anticipation. At a normal descent of about 100° per second, 100 ms is 10° of knee travel: the ding marks "you got there", and you'll be a little past the target when you hear it.

What the app does about it:

- Asks the camera for 60 fps at 960×540 (falls back to 1280×720 or 640×480 if that's where the phone offers 60 fps). Never 1080p.
- Processes each frame the instant Safari presents it (`requestVideoFrameCallback`). Detection is synchronous, so frames that arrive while it's busy are dropped, never queued. A frame older than 120 ms is skipped.
- Lite model on the GPU, warmed up at page load.
- A One Euro filter instead of an average. In the unit tests it adds about 4 ms at squat speed.
- Dings on the first frame at or below target. No confirmation frames.
- **Anticipation** fires when the current angle minus (velocity × one frame) is already at the target. That takes back one frame: 17 ms at 60 fps, 33 ms at 30 fps.
- The audio engine is started on the Start tap and kept running with an inaudible loop, and the next ding is pre-built, so playing it is a single call.

Two ways to claw back more, both with a cost:

- **Extra anticipation lead.** 50 to 80 ms roughly cancels the camera and speaker delay. The cost: if you brake hard just above the target, you get a ding for a rep that never quite got there. The debug line and the latency log count these as "missed".
- **Raise the target a few degrees** (say 95° for a true 90°). Simple and predictable, but it also passes reps that stop at 95°.

**Bluetooth breaks this.** AirPods and Bluetooth speakers add 150 to 300 ms that the app can't see or cancel. The app shows a warning if the browser reports a slow audio output, but Safari mostly doesn't say, so treat the warning as a bonus, not a guarantee. Use the phone speaker.

### Reading the debug line

`58 fps · infer 14 ms · frame→done 30 ms · 960×540@60 · GPU lite · audio +3 ms · drop 2 · awake · early 3/7 (~44 ms)`

- **fps**: frames actually processed per second.
- **infer**: time inside the pose model.
- **frame→done**: from Safari presenting the frame to the app finishing with it. In browsers that report capture time (Chrome) this reads **cam→done** and includes the camera pipeline.
- **camera mode**, **GPU or CPU**, **model**.
- **audio**: output latency the browser admits to.
- **drop**: frames skipped because the previous one was still being processed.
- **awake**: the screen wake lock is held.
- **early a/b (~N ms)**: a of b dings were fired by anticipation, on average N ms before the real crossing. "missed" counts early dings where the knee never reached the target.

**Settings → Copy latency log** copies a JSON record of every ding: frame time, callback time, detection done, ding scheduled, angle and velocity at that moment. The same lines go to the console.

To measure the true end-to-end delay, film yourself and the phone with a second phone in slow motion (240 fps) and count frames between your knee reaching depth and the screen's green flash.

## Tests

```bash
node tests/run-tests.mjs
```

32 tests with synthetic angle sequences: full rep, shallow rep, jitter around the target and around the standing line, re-arming, starting in a squat, custom thresholds, anticipation (fires one frame early, never on the way up, counts misses, capped lead), single-frame tracking glitches, filter lag, and a noisy 8-rep set run end to end at 30 and 60 fps. Node 18 or newer, no packages to install.

## Troubleshooting

- **No sound.** Volume up, then Settings → Test ding. If it's still silent, flip the ring/silent switch to ring and check nothing is connected over Bluetooth.
- **"The camera needs HTTPS".** You opened an `http://` address. Use the GitHub Pages address or `serve.py --https`.
- **Camera permission denied.** In Safari tap the page menu in the address bar → Website Settings → Camera → Allow, then reload.
- **LEG HIDDEN / NO BODY.** The hip, knee or ankle of your camera-side leg isn't clearly visible. Step back so your feet are in frame, or move the tripod so the Smith upright doesn't cover your knee.
- **Debug line shows 30 fps with the camera.** The phone didn't offer a 60 fps mode to Safari at these sizes. It still works; each frame just costs 33 ms instead of 17.
- **It dings on warm-up bends or racking the bar.** Anything that takes the knee past the target counts. Use Settings → Reset counts before the set.
- **Screen dims anyway.** Low Power Mode blocks the wake lock. Turn it off or raise Auto-Lock.

## Credits

Pose tracking is [MediaPipe Pose Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker) (`@mediapipe/tasks-vision` 1.1.0, Apache 2.0), vendored unmodified in `vendor/`.
