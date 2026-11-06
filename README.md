# Job Search Dashboard

A local, private dashboard for tracking job applications. A local LLM running in [LM Studio](https://lmstudio.ai) writes and edits your resumes, cover letters and other documents.

- **Resume from PDF or Word:** load your resume from a `.pdf` or `.docx` file (or drop it in); it's converted to text on your computer. Job descriptions can be loaded from files too. Scanned (image-only) PDFs can't be read; the app tells you so.
- **Jobs:** paste a job description and the AI fills in the title, company, location, salary and keywords. You can track status (saved → applied → screening → interview → offer / rejected / ghosted / withdrawn), notes, contacts, next actions and tags.
- **AI Workspace (per job):** one-click fit analysis with a match score, ATS keyword gap check, tailored resume, cover letter, recruiter message, follow-up and thank-you emails, interview prep and salary negotiation. You can also chat freely. Your profile and the job description are sent with every request.
- **Documents:** save any AI answer as a document, then edit it, ask the AI to revise it, copy it, download it as Markdown, or print / save it as PDF.
- **AI Assistant:** general career chat that knows your profile and every job you're tracking (resume review, LinkedIn About, elevator pitch, "which jobs should I focus on?", weekly plan).
- **Dashboard:** stat tiles for applications, response rate, interview rate, offers, average days to reply, average match score and progress toward your weekly goal. It also shows a 12-week applications chart, the pipeline by status, follow-up reminders and upcoming actions.

Everything is free and runs on your own computer. Nothing is sent to the internet.

## For users (Windows)

1. Download and install **LM Studio** (free) from https://lmstudio.ai. Open it once and download a model. Search for something like *Qwen3 8B* or *Gemma 3 12B*; bigger models write better but need a stronger computer.
2. Double-click **JobSearchDashboard.exe**. The dashboard opens in its own window. Close the window to quit.
   - The first time, Windows may show *"Windows protected your PC"*, because the app isn't code-signed. Click **More info → Run anyway**.
   - Tip: right-click the exe → **Send to → Desktop (create shortcut)**, or pin the open app to the taskbar.
3. Click **Start LM Studio** at the bottom left, pick your model, and click **Load model**.
4. Go to **My Profile** and click **Load from PDF or Word…** (or drop your resume file in), then add jobs.

Your data is saved in `%APPDATA%\Job Search Dashboard` (Settings → **Open data folder**). You can move the .exe anywhere; your data stays where it is.

**If Windows blocks the download with no "Run anyway" option** (common on managed work computers), build and install it from the code instead. You need [Node.js](https://nodejs.org) 25.5+ and [Git](https://git-scm.com):

```sh
git clone https://github.com/fstrafforello/job-search.git
cd job-search
npm install
npm run install-app      # builds the app, installs it for your user, adds Start menu + Desktop shortcuts
```

A copy built on your own computer isn't marked as downloaded, so it isn't blocked the same way. Check your employer's software policy first. Remove it with `npm run install-app -- --uninstall` (your data is kept).

**Updates:** when a new version is out, an *Update available* card appears at the bottom left. Click **Update now**. The app downloads the new version, restarts itself, and keeps all your data. Get the first copy from the [Releases page](https://github.com/fstrafforello/job-search/releases/latest).

## Build the .exe

Needs Node.js 25.5 or newer on the build machine. End users don't need Node.

```sh
npm install          # installs esbuild and rcedit (build-time only)
npm run build:exe    # → dist/JobSearchDashboard.exe (~100 MB, includes the Node runtime)
```

The exe is a normal windowed Windows program (no console) with the icon from `assets/icon.ico`. When started, it opens the dashboard in a Microsoft Edge app window (Chrome or the default browser as fallbacks). That window uses its own profile in `%LOCALAPPDATA%\Job Search Dashboard\Window`. The app quits about 15 seconds after its last window closes. Logs go to `%APPDATA%\Job Search Dashboard\app.log`. If startup fails, the error is shown in the app window.

To change the icon, edit `assets/icon.svg` (and `icon-small.svg` for 16–32 px), then run `npm run icons` to regenerate `assets/icon.ico` and the `public/icon-*.png` files (needs Edge).

## Publish a new version

Commit your changes, then run one of:

```sh
npm run release:patch   # 1.0.0 → 1.0.1  (fixes)
npm run release:minor   # 1.0.0 → 1.1.0  (new features)
```

This raises the version in package.json, commits, tags (`v1.0.1`), and pushes. GitHub Actions (`.github/workflows/release.yml`) then builds the exe on Windows and publishes it as a GitHub Release. Edit the release on GitHub to add notes; they show under **What's new** in the app.

Installed apps check `releases/latest` on start (and every 6 hours while open) and offer **Update now**. The update:
- downloads `JobSearchDashboard.exe`, checks its size and SHA-256 against GitHub's
- renames the running exe to `.old`, puts the new one in its place, and restarts
- reloads the open browser tab.

If anything fails, the current version keeps running unchanged. Users can turn off automatic checks in Settings. Only the version lookup goes to GitHub; no user data is sent.

Users' data is kept across updates. The first time a new version starts, it saves `db.before-<version>.json` next to the data (the last 5 are kept).

If a release changes how data is stored (renamed or restructured fields), add a conversion step in `lib/store.js`'s `merge()` so older data is upgraded on load.

## Run from source (developers)

Needs Node.js 22 or newer.

1. Install dependencies and start the dashboard:
   ```sh
   npm install
   npm start        # or: node server.js
   ```
2. Open http://127.0.0.1:5177.
3. In the **LM Studio** panel at the bottom of the sidebar:
   - click **Start LM Studio**. This runs `lms server start`, and opens the LM Studio app first if its background service isn't up.
   - pick a model from the dropdown (loaded and downloaded models are listed), or choose **Custom model ID…** and type one.
   - click **Load model** if it isn't loaded yet. This unloads other models first and uses the context length from Settings (default 8192).
4. Fill in **My Profile** (load or paste your resume), then add jobs.

**Settings** has the same model picker plus **Unload all** and **Stop server**. It's also where you set the server URL, context length, temperature, max tokens, chat memory and weekly goal, and export or import your data.

The start/load/stop controls use LM Studio's `lms` CLI, which is installed with LM Studio at `~/.lmstudio/bin`. Set `LMS_CLI` or `LMSTUDIO_APP` if yours lives elsewhere. Without the CLI you can still start the server and load models in the LM Studio app; the dashboard detects them either way.

## Configuration

| Env var   | Default          | Purpose                                   |
|-----------|------------------|-------------------------------------------|
| `PORT`    | `5177`           | Dashboard port                            |
| `HOST`    | `127.0.0.1`      | Bind address (keep local, there's no auth) |
| `DB_FILE` | `data/db.json` (source) / `%APPDATA%\Job Search Dashboard\db.json` (.exe) | Where your data is stored |
| `OPEN_BROWSER` | `1` for the .exe, `0` from source | Open the browser on start |

From source, all data lives in `data/db.json`, which is git-ignored. A copy of the previous version is kept in `data/db.backup.json` each time the server starts.

## Layout

```
server.js          HTTP server, REST API, LM Studio streaming proxy
lib/store.js       JSON file persistence
lib/llm.js         LM Studio client + prompt building
lib/lms.js         LM Studio CLI control (start/stop server, load/unload models)
lib/updater.js     Checks GitHub Releases and installs updates in place
lib/desktop.js     App window, log file, startup error page
lib/extract.js     Reads PDF (unpdf / pdf.js) and Word .docx (mammoth) files into text
assets/            Icon sources (SVG) and the generated icon.ico
scripts/make-icons.mjs  Renders the icon PNGs/ICO
scripts/pe.mjs     Exe header tweaks (no console window, drop Node's signature)
.github/workflows/release.yml  Builds and publishes the exe when a v* tag is pushed
scripts/build-exe.mjs  Bundles everything into a single executable
scripts/licenses.mjs   Generates public/third-party-licenses.txt (also run by build:exe)
public/            Single-page app (vanilla JS, no build step)
  app.js           Views, AI quick actions, stats
  util.js          API helper, Markdown renderer, dialogs
  charts.js        SVG/HTML charts + tooltips
```

## Licence

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Copyright 2026 Francesco Strafforello.

The exe also contains the Node.js runtime and the npm packages under `dependencies` (mammoth, unpdf/pdf.js and what they use), each under its own licence. Their full texts are in [public/third-party-licenses.txt](public/third-party-licenses.txt), which the app shows under Settings → About. After adding or upgrading a dependency, run `npm run licenses` and commit the result; `npm run build:exe` also refreshes it.
