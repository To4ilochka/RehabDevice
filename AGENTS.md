# RehabDevice Architecture And Runbook

This file describes the checked-in ESP32 firmware, browser application, and supported local verification workflows. Prefer implementation and build configuration over prose when they disagree. The project is not clinically validated by the presence of clinical terminology or claims in draft documents.

## Authority And Repository Boundaries

- Runtime truth is in `src/`, `include/`, `data/`, `platformio.ini`, `partitions.csv`, and `compress_fs.py`. [README.md](README.md) is useful for wiring and operator context but has stale statements; verify each behavior in code before changing or repeating it.
- `paper/` is Git-ignored publication work: versioned Python generators, draft article text, diagrams, screenshots, and document outputs. It is not a firmware input or a supported build/test pipeline. Some drafts describe a different design; never use them as proof of implemented behavior.
- `.vscode/`, the root documentation `.docx`/`.pdf` files, and most of `scripts/` are ignored local artifacts. Only `scripts/check_static_assets.py` is excepted from the scripts ignore rule. Inspect any local utility before using it: several rewrite files under `data/` directly.
- `.vscode/c_cpp_properties.json` and `launch.json` are PlatformIO-generated and contain machine-specific absolute paths. Change `platformio.ini`, not generated IntelliSense metadata.
- `include/README` is generic PlatformIO scaffold text, not project architecture documentation. There is no checked-in CI workflow, JavaScript package manifest, Python dependency manifest, or PlatformIO `test` environment.

## Project Map

| Area | Responsibility |
|---|---|
| `src/main.cpp` | Global module wiring, boot sequence, FreeRTOS queues/tasks, command dispatch, sensor queue draining, and periodic broadcasts. |
| `include/Config.h` | Hardware pins, firmware defaults, sensor mode, analytics thresholds, AP settings, and a few currently unused constants. |
| `include/SystemCommands.h` | Web-to-loop command enum and fixed-size command payload. |
| `src/SensorMPU.cpp`, `include/SensorMPU.h` | MPU6050-compatible device setup, DMP FIFO reads, 3D gravity-frame zero calibration, angle normalization, and synchronized latest-sample access. |
| `src/AnalyticsEngine.cpp`, `include/AnalyticsEngine.h` | Session lifecycle across Wrist (`0`), Balance Static (`1`), and Balance Dynamic (`2`) modes, mounting/tare mapping, continuous 2-way roll integration, 4-way time-weighted sway RMS / neutral-zone hold / CoB / 4-quadrant distribution, duration-normalized smoothness, and live JSON. |
| `src/DatabaseManager.cpp`, `include/DatabaseManager.h` | Unified `sessions` SQLite schema with idempotent `ALTER TABLE` migration, LittleFS/SD selection and read-safe LittleFS-to-SD merge, `<100 KiB` LittleFS write guard, queued writes, sparse MessagePack paginated reads, and deletes. |
| `src/SDManager.cpp`, `include/SDManager.h` | Optional SD card mount using the configured chip-select pin. |
| `src/WiFiManagerModule.cpp`, `include/WiFiManagerModule.h` | SoftAP setup, DHCP option changes, mDNS name/service, and station count. |
| `src/WebServerModule.cpp`, `include/WebServerModule.h` | Async HTTP routes, WebSocket events and broadcasts, static LittleFS serving, chunked MessagePack session output, and ElegantOTA registration. |
| `data/index.html`, `data/style.css` | Ukrainian single-page dashboard markup and responsive layout. |
| `data/app.js` | Module composition, incoming message routing, and browser-driven GitHub release OTA flow. |
| `data/StateManager.js` | Small observable state store. |
| `data/NetworkService.js` | WebSocket lifecycle, HTTP polling fallback, command transport, and paginated MessagePack reads. |
| `data/UIManager.js` | Patient controls, mode-filtered game picker, session table, patient search/summary, chart, status, and CSV export. |
| `data/GameEngine.js`, `data/games/*/game.js` | Canvas animation loop, 1D/2D visualizers, dual-axis `GameInput` pipeline with mounting orientation helpers, and dynamically loaded Ping-Pong, BalanceBoard, CarDodge, SafeCracker, Balance 3D, and 3D Dragon games. |
| `data/chart.js`, `data/msgpack.min.js` | Locally served vendor bundles: Chart.js 4.5.1 and MessagePack codec. Do not fetch these from a CDN at runtime. |
| `compress_fs.py` | Rebuilds the compressed LittleFS staging tree for filesystem targets. |
| `scripts/check_static_assets.py` | Compares staged files to source assets and optionally checks live HTTP headers and bodies. |
| `test/` | Compile-time angle-wrap assertions and Playwright dashboard regression tests. |

Use the module that owns a behavior. Keep firmware sensor acquisition, command dispatch, persistence, HTTP transport, frontend state, DOM rendering, and game logic in their existing boundaries instead of duplicating behavior across layers.

## Firmware Lifecycle And Data Flow

### Boot sequence

`setup()` currently performs these operations in order:

1. Releases the Bluetooth controller memory, starts Serial at 115200 baud, and prints the startup banner.
2. Mounts LittleFS. If the mount fails, it calls `LittleFS.begin(true)`, which may format the filesystem. This can erase the local SQLite backup; preserve data before changing mount/format behavior.
3. Attempts the SD mount. Failure is logged and startup continues.
4. Initializes SQLite using the SD availability flag. When SD is selected, the manager attempts to copy an existing `/rehab.db` from LittleFS to SD and then removes the LittleFS copy after successful migration. If no SD is available, the active path is `/littlefs/rehab.db`.
5. Starts SoftAP/mDNS and the asynchronous web server.
6. Initializes the MPU/DMP. Sensor failure is a warning; the program still creates queues/tasks, and `SensorMPU::update()` then returns without samples when DMP is not ready.
7. Creates `mpuDataQueue` (100 `MPUData` items), `sysCommandQueue` (10 `SysCommandMsg` items), and `dbQueue` (10 `SessionRecord` items), then creates `SensorTask` (4096 stack) and `DBTask` (8192 stack) pinned to core 0.

The web server is started before `sysCommandQueue` is created; `WebServerModule` command handlers check `sysCommandQueue != NULL` and drop early commands until queue initialization. Preserve that guard when changing startup or adding commands. Task-creation and queue-creation return values are not currently checked; do not assume startup detects allocation failure.

### Tasks, queues, and synchronization

| Execution context | Current behavior |
|---|---|
| `SensorTask` | Pinned to core 0, priority 5. In interrupt mode it blocks on task notification; by default it delays for `MPU_POLL_INTERVAL_MS` (5 ms). It calls `sensor.update()`, consumes the latest updated sample with `getData()`, and tries a zero-wait send to `mpuDataQueue`. |
| `DBTask` | Pinned to core 0, priority 2. Waits forever on `dbQueue` and calls the blocking `saveSessionDb()` path. |
| Arduino `loop()` | Framework-owned context. Drains system commands, calls WebSocket cleanup/update, drains all currently queued sensor data into analytics, broadcasts angle every fifth dequeued sample, and calls the throttled status broadcaster. |
| Async HTTP/WebSocket callbacks | Run concurrently with `loop()` and the pinned tasks. They read shared services and enqueue loop-owned actions. They are not pinned or assigned a project priority in this repository. |

- `mpuDataQueue`: producer is `SensorTask`; consumer is `loop()`. A zero-wait send can fail when full, and the return value is ignored. Do not promise lossless acquisition without measuring queue pressure.
- `sysCommandQueue`: producers are HTTP/WebSocket callbacks; consumer is `loop()`. Sends are zero-wait and their results are ignored. Handle queue-full behavior when adding commands.
- `dbQueue`: producer is the loop on session stop; consumer is `DBTask`. `saveSession()` returns whether enqueueing succeeded, but the current loop ignores that result. A full queue can lose a completed session.
- `SensorMPU` protects `currentData` with a mutex and atomically counts failed lock attempts. `getData()` consumes `dataUpdated` and `recalibrated`; `peekData()` does not. `recalibrate()` sets an atomic `recalibratePending` flag consumed by `SensorMPU::update()`, keeping post-boot `Wire` I2C access exclusively inside `SensorTask`.
- `AnalyticsEngine` uses a recursive mutex because public methods call other locked methods. Keep its state behind those methods.
- `DatabaseManager` has a mutex and exposes `stepSessionRow()`, `stepStatement()`, and `finalizeStatement()` for the chunked reader in `WebServerModule.cpp` so stepping and `sqlite3_column_*` reads run together under `dbMutex`. Keep SQLite operations behind synchronized manager APIs. The current lock is per operation, not a transaction spanning an entire streamed response; audit any new `sqlite3_*` use against concurrent DBTask writes.
- Do not perform blocking device control or long work inside asynchronous callbacks. Keep loop-owned control routed through `sysCommandQueue`; keep potentially slow SQLite writes in `DBTask`.

### Sensor and analytics pipeline

1. The MPU DMP produces FIFO packets. `SensorMPU::init()` starts I2C on GPIO 21/22 at 100 kHz, probes address `0x68`, initializes/calibrates the DMP, then switches I2C to 400 kHz. Accepted WHO_AM_I values include `0x68`, `0x70`, `0x71`, `0x73`, and `0x98`.
2. With `MPU_USE_INTERRUPT=1`, GPIO 17 rising-edge ISR notifies `SensorTask` using `vTaskNotifyGiveFromISR`; the ISR does not read I2C. With the current default `0`, no interrupt is attached and the task polls after a 5 ms delay. The actual DMP/output sample rate must be measured; do not infer 100 Hz from old prose or comments.
3. FIFO overflow (`status` overflow bit or at least 1024 bytes), invalid quaternion norm (`normSq` outside 0.5..1.5), and non-finite angles cause FIFO reset or packet rejection. The sensor converts raw gyro values by 131 LSB/(degree/s), accelerometer values by 16384 LSB/g, rotates the DMP gravity vector by `gravRefMatrix` (shortest-arc Rodrigues rotation mapping the calibrated resting gravity vector to `(0, 0, +1)` without 6-axis yaw drift or `gz < 0` pitch discontinuities), and normalizes calibrated Yaw/Pitch/Roll to `[-180, 180]`.
4. `loop()` processes every sample it successfully dequeues. `AnalyticsEngine` applies mounting orientation flags (`invertX`, `invertY`, `swapAxes`) and software tare (`tareRoll`, `tarePitch`). In 2-way Wrist mode (`0`), it integrates the shortest signed difference between successive normalized rolls (skipping the step delta on `data.recalibrated`) so session angle is continuous beyond +/-180 degrees. In 4-way Balance Static (`1`) and Dynamic (`2`) modes, it tracks shortest-delta tared roll/pitch tilt, time-weighted `swayRms` (`mlRms`/`apRms`), `<= 5.0` degree `stabilityPct`, `meanRoll`/`meanPitch` CoB bias, and 4-quadrant percentages (`qFL`, `qFR`, `qBL`, `qBR` outside `1.5` degrees).
5. Across all modes, smoothness is duration-normalized (`spikesPerMin = tremorSpikesCount / max(activeMotionSec, 5.0) * 60`, `smoothness = clamp(100 - spikesPerMin * 1.5, 0, 100)`). Wrist hysteresis reversal threshold is 4 degrees. No raw session trace is stored in SQLite.
6. Session start captures system Unix time if already synchronized; otherwise the timestamp falls back to elapsed uptime. The browser sends `syncTime` on connection. Human-readable date fallback is a session-relative string, not a calendar timestamp.

`ANALYTICS_HOLD_TOLERANCE_DEG`, `ANALYTICS_HOLD_MAX_SPEED_DEG_S`, and `FS_SESSIONS_DIR` are currently declared but have no implementation references. `FS_MIN_FREE_BYTES` (`100 KiB`) guards LittleFS writes without auto-deleting un-migrated patient data (`storageLowSpace: true`). `AngleMath.h` provides shortest-angle difference, orientation mapping, and 4-quadrant symmetry helpers.

### Session persistence

- `sessions` is the unified table: core columns (`id`, `patient_id`, `timestamp`, `date_str`, `min_angle`, `max_angle`, `amplitude`, `avg_speed`, `smoothness`, `flexions_count`, `session_duration`) plus `session_mode INTEGER DEFAULT 0` and 12 nullable `REAL` balance columns (`min_pitch`, `max_pitch`, `mean_roll`, `mean_pitch`, `sway_rms`, `ml_rms`, `ap_rms`, `stability_pct`, `q_fl`, `q_fr`, `q_bl`, `q_br`), migrated idempotently via `PRAGMA table_info`. Sparse MessagePack serialization omits the 12 balance keys when `sessionMode == 0`.
- Completed sessions are inserted asynchronously through `dbQueue`. There are up to three insert attempts with brief delays and a SQLite busy timeout of 1000 ms. SQLite memory-status and lookaside allocations are disabled at initialization.
- Reads are ordered by `timestamp DESC` and use `limit`/`offset`. The query is streamed as a MessagePack array; each row is stepped and serialized into an async response buffer rather than building one full JSON response.
- Patient/session deletion is permanent and removes matching rows; there is no separate patient table or foreign-key relation.
- Actual fallback behavior is based on whether SD mount succeeded. If SD mounted but opening/using the SD database fails, the code does not transparently switch to LittleFS. Do not promise stronger fallback than implemented.
- Migration and first-mount formatting are data-changing operations. Back up the database before changing migration, filesystem formatting, or storage selection.

## Network And Browser Contracts

### Device network

- The device runs `WIFI_AP` only, with defaults `RehabDevice_AP`, password `rehab1234`, channel 1, maximum four stations, and address `192.168.4.1/24`.
- `WiFiManagerModule` disables DHCP router and DNS options and starts mDNS as `rehab.local` with an HTTP service. There is no DNS server, wildcard redirect, or captive-portal probe route in the current code. Open `http://192.168.4.1` or `http://rehab.local` manually; automatic captive-portal behavior is not established by this implementation.
- The AP credentials are compiled into firmware. There is no application authentication layer on the current API. Treat patient identifiers and destructive commands accordingly; do not claim the API is authenticated or internet-facing-safe.

### HTTP and WebSocket API

| Interface | Current contract |
|---|---|
| `GET /api/status` | JSON status, connected-client count, session/patient/`sessionMode` state, `storageLowSpace`, current `angle` (roll compatibility alias), numeric `roll` and `pitch`, SD availability, and sensor mutex misses. `usedBytes` and `totalBytes` are zero when SD is active and reflect LittleFS usage otherwise. This route does not set firmware version. |
| `GET /api/sessions?offset=N&limit=N` | Paged `application/msgpack` array of session objects. Defaults are offset 0 and limit 50 (clamped to `limit` 1..200 and `offset >= 0`). |
| `GET /api/cmd?action=...` | Mutating command endpoint for `syncTime`, `startSession`, `stopSession`, `recalibrate`, `syncOrientation`, `setTare`, `deletePatient`, `deleteSession`, and `reboot`. It uses GET and has no authentication. Reboot responds first, then delays 500 ms in a short-lived task before restarting. |
| WebSocket `/ws` | Client messages are JSON commands for time sync, session start/stop, recalibration, and deletes. Decimated `angle` messages include the roll compatibility alias plus numeric `roll` and `pitch`; other server messages include `liveStats` and `status`, and WebSocket status includes firmware version. |
| ElegantOTA `/update` | Registered by `ElegantOTA.begin(&server)`. The UI also downloads release assets from GitHub and posts them to the device update endpoint. This changes device firmware/filesystem. |
| `/` and static files | `serveStatic("/", LittleFS, "/")`, default `index.html`, with cache revalidation. Missing root gets fallback HTML; missing GET assets log and return 404. |

`CMD_REBOOT` and `CMD_SWITCH_MODE` exist in the command enum but are not handled by the main-loop switch. Reboot currently uses the HTTP action directly. Do not expose enum values as implemented commands without adding and testing a consumer.

`loop()` emits an angle after each fifth dequeued sample; `broadcastLiveStats()` independently limits messages to one per 200 ms, and status is throttled to 2000 ms. A comment describes 100 sensor packets/s, but the default is polling and actual rate depends on DMP timing and queue delivery. Status/memory fields in the API are not a measured heap report.

### Browser application

- `index.html` loads local Chart.js and MessagePack bundles, then `app.js` as an ES module. `app.js` wires StateManager, NetworkService, UIManager, and GameEngine (`window.engineInstance`), routing incoming sensor telemetry to `GameEngine.setRawAngles(roll, pitch)`. `UIManager.js` binds `#invertAngleToggle`, `#invertPitchToggle`, and `#swapAxesToggle` to `GameEngine.setAxisOrientation()` (and `setAxisInversion()` remains supported) so raw angles and tare offsets transform together without a zero-origin jump. On `#tabPatient`, `#btnRecalibrate` triggers hardware `recalibrate` and `GameEngine.resetTare()`; `#btnTareGameInput` lives inside `#gameContainer .game-overlay-header` for quick in-game zeroing.
- WebSocket is attempted first. If it is not open after 8 seconds, or closes, the client uses `/api/status` polling every 250 ms and continues background reconnect attempts every 5 seconds (up to 10 attempts), then retries after a 75-second recovery timer. Session history is always fetched from the HTTP MessagePack endpoint in pages of 50.
- The visualizer uses shortest-path angular interpolation for the 1D wrist circle (`two-direction` mode) and a 2D bubble puck (`#balanceBoardVisualizer`, `four-direction` mode). Games receive the target sensor angles directly from the animation loop. The engine's `requestAnimationFrame` loop continues after app initialization even when no game is active.
- `UIManager` owns the dashboard DOM. Selecting `#gameInputMode` (`two-direction` vs `four-direction`) dynamically rebuilds `#gameSelect` options so only 2-way or 4-way games are listed, and toggles the 4-way mounting controls and 1D/2D visualizer. The ALL view includes every loaded session; selecting a patient filters the same eight-column history table. The table intentionally scrolls horizontally inside its container on mobile and cells remain single-line. Keep document-level horizontal overflow out of responsive changes.
- The dashboard validates a target norm in the inclusive 10..180 range and calculates recovery percentage. Historical chart amplitudes can exceed 180; the chart raises its Y maximum dynamically. Reject non-finite chart coordinates and preserve the empty/loading/error/no-results states.
- CSV export is created in-browser from loaded sessions. Preserve Ukrainian column labels, text escaping, and existing session semantics.
- Games are loaded from `/games/<id>/game.js` on first use (deduplicated per script load and guarded by `loadRequestId`) and registered via `window.RehabGames.register(id, GameClass, { directions: 2 | 4, inputMode: "2way" | "4way" })`: horizontal 2-way cartridges (`pingpong`, `balanceboard`, `cardodge`, `safecracker`) ignore pitch and apply `input.rollTare`, while 4-way cartridges (`balance3d`, single-viewport non-VR `vrdragon`) auto-select `four-direction` on start and lock vertical motion to `0` if `#gameInputMode` is toggled to `two-direction` at runtime via `GameEngine.setInputMode()`. Standalone `new GameInput()` defaults to `0.08` deadzone and `30`-degree sensitivity; `GameEngine` configures `{ deadzone: 0.08, sensitivityDeg: 30 }` in `two-direction` mode and `{ deadzone: 0.05, sensitivityDeg: 15 }` in `four-direction` balance-board mode, passing `GameInput` as the optional third runtime argument to `update` (`input.getAxis("Horizontal"|"Vertical")`, tared on game start or `#btnTareGameInput`). Each cartridge receives `(ctx, api)` in its constructor and implements `init(canvas, options)`, `update(angle, dt)` (keep formal arity `2` and read `input` via `arguments[2]` or a default parameter, as verified in `test/test_doctor_dashboard.py`), `draw(ctx)`, optional `resize(width, height)`, and `stop()` (cleaning up timers/listeners and transient state); `GameEngine` supplies CSS-pixel dimensions while scaling the canvas backing store up to 2x `devicePixelRatio`.
- UI strings and exported reports are Ukrainian. The release checker requires external Internet access to GitHub; local monitoring, API, and static assets are served by the device.

## Hardware, Flash, And Configuration

### Hardware connections

| Device | Signal | ESP32 pin / setting | Notes |
|---|---|---|---|
| MPU6050/compatible | SDA | GPIO 21 | I2C address is hard-coded as `0x68`; AD0 should be low. |
| MPU6050/compatible | SCL | GPIO 22 | I2C starts at 100 kHz, then changes to 400 kHz after DMP setup. |
| MPU6050/compatible | INT | GPIO 17 | Used only when `MPU_USE_INTERRUPT=1`; not needed in default polling mode. |
| SD module | CS | GPIO 5 | `SD.begin(SD_CS_PIN)` uses Arduino ESP32 SPI defaults for the other VSPI pins (SCK 18, MISO 19, MOSI 23); there is no custom SPI pin mapping in this project. |
| SD module | power | 5 V/VIN per README wiring | Confirm the specific breakout's regulator/logic requirements. |
| MPU board | power | 3.3 V per README wiring | Keep the sensor logic within board limits. |

The configured PlatformIO board is `esp32dev`; hardware comments identify ESP-WROOM-32. Do not infer sensor identity or board flash/RAM size from publication drafts. The partition table occupies offsets through `0x3F1000`; remaining address space depends on the physical flash capacity.

### Partition map

Source of truth: [partitions.csv](partitions.csv). Sizes below are calculated from the table; `spiffs` is the partition label/type even though PlatformIO is configured to format/use LittleFS.

| Name | Type/subtype | Offset | Size | Purpose in this project |
|---|---|---:|---:|---|
| `nvs` | data/nvs | `0x9000` | `0x5000` (20 KiB) | NVS. |
| `otadata` | data/ota | `0xE000` | `0x2000` (8 KiB) | OTA metadata. |
| `app0` | app/ota_0 | `0x10000` | `0x180000` (1536 KiB) | OTA app slot 0. |
| `app1` | app/ota_1 | `0x190000` | `0x180000` (1536 KiB) | OTA app slot 1. |
| `spiffs` | data/spiffs | `0x310000` | `0xE0000` (896 KiB) | LittleFS static UI and fallback SQLite file. |
| `eeprom` | data/`0x99` | `0x3F0000` | `0x1000` (4 KiB) | Custom data partition; no project code currently uses it. |

SQLite paths are `/sd/rehab.db` and `/littlefs/rehab.db`. LittleFS also serves the static website from `/`. An `uploadfs` replaces that whole partition, including a LittleFS database backup.

### PlatformIO environment and build flags

`platformio.ini` defines one environment, `esp32dev_RehabDevice`:

- Platform `espressif32` (not version-pinned), board `esp32dev`, Arduino framework, serial monitor at 115200 baud.
- `board_build.partitions = partitions.csv`; `board_build.filesystem = littlefs`.
- Pre-script `compress_fs.py` prepares filesystem assets for `buildfs`, `uploadfs`, and `uploadfsota` targets.
- Dependencies: `bblanchon/ArduinoJson@^7.4.3`, `esp32async/ESPAsyncWebServer@^3.12.0`, `jrowberg/I2Cdevlib-MPU6050@^1.0.0`, `siara-cc/Sqlite3Esp32@^2.5`, and `ayushsharma82/ElegantOTA@^3.1.7`.
- Build flags: `CORE_DEBUG_LEVEL=1`, `CONFIG_LWIP_MAX_ACTIVE_TCP=16`, and `ELEGANTOTA_USE_ASYNC_WEBSERVER=1`.

`include/Config.h` currently defines:

| Symbol | Current value | Meaning / use |
|---|---:|---|
| `FIRMWARE_VERSION` | `v1.0.1` | Reported in WebSocket status. |
| `PIN_I2C_SDA`, `PIN_I2C_SCL` | 21, 22 | Sensor I2C. |
| `PIN_MPU_INT` | 17 | DMP interrupt pin when interrupt mode is enabled. |
| `SD_CS_PIN` | 5 | SD chip select. |
| `MPU_USE_INTERRUPT` | 0 | Guarded by `#ifndef`; can be overridden with a compiler define. `1` enables the ISR path; default `0` polls. `platformio.ini` does not override it. |
| `MPU_POLL_INTERVAL_MS` | 5 | Polling-task delay in default mode. |
| `WIFI_AP_SSID`, `WIFI_AP_PASSWORD` | `RehabDevice_AP`, `rehab1234` | Compiled SoftAP credentials; change deliberately for deployments. |
| `WIFI_AP_CHANNEL`, `WIFI_AP_MAX_CONNECTIONS` | 1, 4 | AP radio channel and max stations. |
| `WEB_SERVER_PORT` | 80 | HTTP/mDNS service port. |
| `STATUS_UPDATE_INTERVAL_MS` | 2000 | WebSocket status broadcast throttle. |
| `ANALYTICS_HYSTERESIS_DEG` | 4.0 | Flexion state reversal threshold. |
| `ANALYTICS_TREMOR_JERK_THRESHOLD` | 300.0 | Jerk threshold in the analytics path. |
| `ANALYTICS_BALANCE_NEUTRAL_DEG` | 5.0 | Planar tilt radius threshold for 4-way neutral-zone hold (`stabilityPct`). |
| `ANALYTICS_QUADRANT_DEADZONE_DEG` | 1.5 | Center deadzone radius before attributing 4-way dwell time to a quadrant. |
| `ANALYTICS_HOLD_TOLERANCE_DEG` | 3.5 | Declared but unused; there is no 1D wrist hold-time detector. |
| `ANALYTICS_HOLD_MAX_SPEED_DEG_S` | 6.0 | Declared but unused; there is no 1D wrist hold-time detector. |
| `FS_MIN_FREE_BYTES` | 100 KiB | LittleFS free-space floor; blocks new LittleFS writes/sessions without deleting un-migrated rows. |
| `FS_SESSIONS_DIR` | `/p` | Declared but unused; no per-patient JSONL files are implemented. |

`DEBUG_VERBOSE` is checked in `WebServerModule.cpp` but is not defined by the project configuration. Do not assume it is enabled. `CMD_REBOOT`/`CMD_SWITCH_MODE` are also unused enum values.

## Filesystem Asset Pipeline

1. The source of browser assets is `data/`, including nested game scripts and vendor bundles.
2. `compress_fs.py` deletes/recreates `.pio/build/esp32dev_RehabDevice/data_compressed`. It gzip-compresses `.html`, `.css`, `.js`, `.json`, `.svg`, and `.txt` with deterministic gzip metadata; other files are copied unchanged. Compressed names gain `.gz`.
3. The pre-script invokes preparation only when the command line target includes `buildfs`, `uploadfs`, or `uploadfsota`. A firmware-only build does not refresh the staged website.
4. ESPAsyncWebServer serves logical URLs and resolves compressed assets. Run the checker after `buildfs`; it verifies every expected staged file, decompressed bytes, and exact file set. `--base-url` additionally verifies HTTP status, MIME, encoding, cache behavior, and body bytes for each logical asset.

Never diagnose a live CSS/JS failure from source files alone: verify the staged bytes, then HTTP delivery. The host browser suite does not exercise this gzip/server path.

## Operational Workflows

Run commands in PowerShell from the project root. On this Windows setup, the installed PlatformIO executables are:

```powershell
$pio = "$env:USERPROFILE\.platformio\penv\Scripts\platformio.exe"
$pioPython = "$env:USERPROFILE\.platformio\penv\Scripts\python.exe"
```

### Build and filesystem verification

```powershell
& $pio run -e esp32dev_RehabDevice
& $pio run -e esp32dev_RehabDevice -t buildfs
& $pioPython scripts/check_static_assets.py
```

For UI-only development, the browser suite uses the uncompressed `data/` source. To verify packaging, always build the filesystem image before running the asset checker; a plain firmware build is insufficient.

### Tests

Install the browser dependency and engines if missing:

```powershell
python -m pip install playwright
python -m playwright install chromium webkit
```

Run the doctor dashboard suite:

```powershell
python -m unittest discover -s test -p test_doctor_dashboard.py -v
```

It serves `data/` from a local threaded HTTP server, runs Chromium and WebKit, exercises mocked/synthetic sessions and network responses, and checks 320, 390, 430, 768, and 1280 CSS-pixel layouts. It covers session states, pagination, CSV/delete interactions, norm validation, chart points including historical amplitudes, mobile table overflow, focus visibility, touch targets, dual-axis WebSocket/HTTP telemetry, `GameInput` normalization/tare/inversion/mode toggling, and lifecycle/DPR checks across all six games in `data/games/*/game.js`. Screenshots go to `.pio/dashboard-checks/`. The suite does not contact the ESP32, verify the flashed filesystem, or establish physical iPhone Safari behavior. Wait for explicit DOM/layout assertions; do not wait for `networkidle` because polling and reconnect timers are intentional.

Run angle wrap compile-time assertions with the installed ESP32 compiler:

```powershell
& "$env:USERPROFILE\.platformio\packages\toolchain-xtensa-esp32\bin\xtensa-esp32-elf-g++.exe" -std=c++11 -Wall -Wextra -Werror -I include -fsyntax-only test/test_angle_normalization.cpp
```

These are `static_assert` checks, not a PlatformIO test target or runtime sensor test. They cover normalized +/-180 transitions and continuous angle accumulation.

### Serial logging and device upload

Serial output is configured at 115200 baud. To open the monitor:

```powershell
& $pio device monitor -e esp32dev_RehabDevice
```

Use startup logs to distinguish LittleFS mount/format, SD mount, SQLite open/migration, AP/mDNS, and DMP initialization failures. Close Serial Monitor before USB upload if the port is held open.

The following commands change hardware and must not be run without explicit user approval:

```powershell
& $pio run -e esp32dev_RehabDevice -t upload
& $pio run -e esp32dev_RehabDevice -t uploadfs
```

`upload` changes firmware. `uploadfs` replaces LittleFS and can erase the local database backup. Confirm that required data is backed up and the intended device/port is selected before an approved upload. Do not flash merely to validate a host-side change.

### Live asset verification

After joining the device AP, check current delivery without uploading:

```powershell
& $pioPython scripts/check_static_assets.py --base-url http://rehab.local
& $pioPython scripts/check_static_assets.py --base-url http://192.168.4.1
curl.exe --noproxy "*" --compressed -i http://rehab.local/style.css
```

Use the reachable host only. Expect the logical CSS URL to return `text/css`, gzip encoding for compressed assets, a revalidation/no-store cache policy, and the decompressed source body. A successful host build or Playwright run is not proof of device delivery. Physical iPhone Safari behavior, captive-portal presentation, and live sensor accuracy require device checks and must be reported separately.

## Cross-Cutting Engineering Rules And Known Limits

- Treat this as a concurrent embedded system. Protect shared state and SQLite access; keep ISR code minimal; do not add blocking I2C, SQLite, logging loops, or long computations to an ISR or async server callback.
- Preserve queue ownership and check zero-wait send failures when changing throughput or command behavior. Current sensor, command, and completed-session queues can drop data/actions under pressure.
- Avoid holding a sensor lock while doing networking, analytics, or storage. Avoid exposing raw SQLite handles or adding unguarded `sqlite3_*` calls.
- Keep database reads paginated and streamed. Keep the MessagePack field names and types aligned among SQLite query columns, server serialization, browser decoder, and tests.
- When changing sampling cadence, audit SensorTask, queue capacity, packet drains, angle broadcast cadence, analytics `dt`, and browser interpolation together. The DMP output rate is not established by the 5 ms polling delay.
- Treat session names as user input. Preserve bounded `patientId` copies in `SysCommandMsg`; avoid unsafe DOM HTML insertion for patient-controlled text. Do not add a remote/internet-facing control surface without an explicit security design.
- `/api/cmd` uses GET for mutations and has no authentication. Deletions are permanent. Preserve or deliberately redesign these semantics with UI confirmation, tests, and operator messaging.
- Do not claim automatic captive portal: current code has SoftAP and mDNS but no DNS redirect/probe handlers. Do not claim hold-time analytics, per-patient JSONL, LittleFS retention cleanup, memory telemetry, or lossless acquisition; related docs/constants are stale or unused.
- README and paper drafts contain conflicting implementation claims (interrupt default, task/core allocation, sample rates, captive portal, database fields, OTA guarantees, and analytics). Verify behavior against source and the actual installed library/build before documenting it. Avoid importing unverified clinical performance, reliability, security, or hardware claims from drafts.
- Keep UI labels, alerts, and CSV headers in Ukrainian. For dashboard changes, preserve all-patient semantics, the eight-column scrollable table, stable DOM nodes/state, loading/error/empty states, norm boundaries, chart range, and mobile focus/touch behavior.
- Use focused checks for the touched surface, then required broader checks if shared behavior changed. Report what was run and distinguish compiler/host-browser evidence from hardware and live-device evidence.

## Code And Documentation Conventions

- Follow local C++ header guards and module APIs; JavaScript is native ES modules with semicolons; Python tests use `unittest` and snake_case methods. Match surrounding indentation and avoid unrelated formatting.
- Keep production assets in `data/`; do not add CDN runtime dependencies. Add reusable frontend dependencies only through an explicit project/build decision (there is no npm setup today).
- Update this file only when durable agent-facing behavior, verified commands, architecture, or safety boundaries change. Put operator/hardware detail in `README.md` and link it here instead of duplicating long procedures.
