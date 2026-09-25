# 🏥 RehabDevice — Автономна медична IoT-система моніторингу реабілітації кисті (ESP32)

**RehabDevice** — це професійний автономний медико-інженерний IoT-комплекс на базі мікроконтролера **ESP32** та 6-осьового інерційного датчика **MPU6050 / MPU6500 (GY-521)**. Система призначена для точного відстеження рухомості суглобів кисті в реальному часі, автоматичного визначення плавності та тремору, збору клінічної аналітики, а також **гейміфікації процесу реабілітації**.

Весь користувацький веб-інтерфейс, медичні показники, ігровий модуль та експортовані CSV-звіти працюють **виключно українською мовою** 🇺🇦 з дотриманням сучасної медичної термінології.

> **Ключова особливість:** Пристрій повністю незалежний від зовнішнього інтернету. Він створює власну Wi-Fi точку доступу (`RehabDevice_AP`) з підтримкою **Captive Portal** (автоматичне спливаюче вікно на iOS та Android). Уся база даних сесій зберігається у **SQLite на SD-карті** з автоматичним резервуванням у `LittleFS`.

---

## 📦 Версія прошивки

**`v1.0.1`**

---

## 🗂 Структура проєкту

```
esp32dev-RehabDevice/
├── src/                        # Прошивка (C++/Arduino)
│   ├── main.cpp                # Точка входу: FreeRTOS задачі, основний цикл
│   ├── SensorMPU.cpp           # Підсистема сенсора (DMP, ISR, рекалібрування)
│   ├── AnalyticsEngine.cpp     # Клінічний аналітичний рушій
│   ├── DatabaseManager.cpp     # SQLite3: збереження/читання сесій, міграція
│   ├── SDManager.cpp           # Ініціалізація SD-карти
│   ├── WebServerModule.cpp     # AsyncWebServer, WebSocket, REST API, OTA
│   └── WiFiManagerModule.cpp   # SoftAP + Captive Portal
├── include/                    # Заголовні файли (*.h)
│   ├── Config.h                # Всі константи: піни, мережа, аналітика
│   ├── SystemCommands.h        # FreeRTOS-черга міжмодульних команд
│   ├── AnalyticsEngine.h
│   ├── DatabaseManager.h
│   ├── SDManager.h
│   ├── SensorMPU.h
│   ├── WebServerModule.h
│   └── WiFiManagerModule.h
├── data/                       # Веб-інтерфейс (SPA, завантажується у LittleFS)
│   ├── index.html              # Єдина сторінка застосунку (SPA)
│   ├── style.css               # Стилі
│   ├── app.js                  # Точка входу SPA + OTA-логіка
│   ├── StateManager.js         # Реактивний стан застосунку
│   ├── NetworkService.js       # WebSocket + HTTP fallback + MsgPack пагінація
│   ├── UIManager.js            # Весь рендеринг UI, графіки, таблиці
│   ├── GameEngine.js           # Ігровий рушій (requestAnimationFrame loop)
│   ├── chart.js                # Chart.js (автономно, без CDN)
│   ├── msgpack.min.js          # MessagePack (без CDN)
│   └── games/
│       ├── pingpong/game.js    # Пінг-понг зі Smart Bot
│       ├── balanceboard/game.js# Баланс-Борд
│       └── cardodge/game.js    # Car Dodge
├── scripts/                    # Допоміжні Python-скрипти для розробки
├── compress_fs.py              # Pre-build: gzip-стиснення файлів LittleFS
├── partitions.csv              # Таблиця розділів (OTA + LittleFS)
└── platformio.ini              # Конфігурація збірки PlatformIO
```

---

## 🎮 Ігровий модуль (Game Therapy)

Система включає потужний модуль ігрової терапії, який перетворює медичні вправи на захопливий процес. Ігри рендеряться через `<canvas>` браузера; ігровий рушій (`GameEngine.js`) крутить `requestAnimationFrame`-цикл на ~60 FPS.

Кожна гра завантажується **динамічно** (`<script>` injection) з `LittleFS` при першому запуску, що економить пам'ять.

| Гра | Спрямованість |
|---|---|
| 🎮 **Пінг-понг (Smart Bot)** | Досягання крайніх кутів амплітуди. Адаптивний бот підлаштовує складність під реальну амплітуду та плавність рухів пацієнта |
| ⚖️ **Баланс-Борд** | Розвиток дрібної моторики та контролю тремору. Утримання дошки рівно проти хвиль та поривів вітру |
| 🏎️ **Car Dodge** | Швидкість реакції. Керування машинкою та уникання перешкод потребує швидких і точних рухів зап'ястям |

---

## 🛠 Апаратне підключення (Розпіновка)

Компоненти: **ESP32 DevKit**, **GY-521 (MPU-6050/6500)**, **MicroSD Card Adapter**.

### Підключення гіроскопа (GY-521) — I²C

| Вивід GY-521 | Пін ESP32 | Призначення |
|:---|:---|:---|
| **VCC** | **3V3** | Живлення (3.3V) |
| **GND** | **GND** | Земля |
| **SCL** | **GPIO 22** | I²C Clock |
| **SDA** | **GPIO 21** | I²C Data |
| **INT** | **GPIO 17** | Апаратне переривання DMP (ISR) |
| **AD0** | **GND** | Фіксація I²C адреси `0x68` |

### Підключення SD-карти — VSPI (SPI)

| Вивід SD-модуля | Пін ESP32 | Призначення |
|:---|:---|:---|
| **VCC** | **5V (VIN)** | Живлення |
| **GND** | **GND** | Земля |
| **MISO** | **GPIO 19** | Master In Slave Out |
| **MOSI** | **GPIO 23** | Master Out Slave In |
| **SCK** | **GPIO 18** | Serial Clock |
| **CS** | **GPIO 5** | Chip Select |

> [!IMPORTANT]
> **Стабільність живлення — обов'язково!**
> При одночасній роботі Wi-Fi та запису на SD-карту можливі просадки напруги.
> Встановіть електролітичний конденсатор **470 мкФ (10–16V)** у шину живлення на макетній платі.

---

## 📂 Встановлення (PlatformIO)

**Залежності** (завантажуються автоматично):

| Бібліотека | Версія | Призначення |
|---|---|---|
| `bblanchon/ArduinoJson` | `^7.4.3` | JSON/MsgPack серіалізація |
| `esp32async/ESPAsyncWebServer` | `^3.12.0` | Асинхронний HTTP + WebSocket |
| `jrowberg/I2Cdevlib-MPU6050` | `^1.0.0` | DMP, кватерніони, YPR |
| `siara-cc/Sqlite3Esp32` | `^2.5` | SQLite3 на Flash/SD |
| `ayushsharma82/ElegantOTA` | `^3.1.7` | OTA через браузер |

**Кроки:**

1. Встановіть **Visual Studio Code** + розширення **PlatformIO IDE**.
2. Відкрийте теку `esp32dev-RehabDevice` у VSCode.
3. PlatformIO автоматично встановить усі залежності.

---

## 🚀 Прошивка та запуск

У лівій панелі VSCode → іконка **PlatformIO** → `Project Tasks` → `esp32dev_RehabDevice`:

### Крок 1. Прошивка коду (C++)
`General` → **Upload**

### Крок 2. Прошивка веб-інтерфейсу (LittleFS)
> [!WARNING]
> Перед прошивкою файлової системи закрийте **Serial Monitor**, інакше отримаєте помилку порту.

`Platform` → **Build Filesystem Image** → **Upload Filesystem Image**

> Скрипт `compress_fs.py` автоматично стискає JS/CSS через gzip перед упаковкою в образ LittleFS.

#### Static asset delivery checks

`compress_fs.py` refreshes the staging directory during the pre-script for
`buildfs`, `uploadfs`, and `uploadfsota`, before PlatformIO constructs the image
builder. The previous image pre-action did not run with this PlatformIO setup,
so a successful filesystem upload could still contain stale staged assets.
Gzip output is deterministic; other files are copied without modification.

ESPAsyncWebServer 3.12.0 resolves logical URLs such as `/style.css` to
`/style.css.gz`, sets `Content-Type: text/css`, and adds `Content-Encoding: gzip`.
JavaScript uses the valid MIME type `text/javascript`. The same root static
handler covers nested game scripts, fonts, and media. Static responses require
cache revalidation; missing assets return uncached errors and are logged on
Serial. No HTML or CSS workaround is needed.

Run from the project directory in PowerShell:

```powershell
& "$env:USERPROFILE\.platformio\penv\Scripts\platformio.exe" run -e esp32dev_RehabDevice
& "$env:USERPROFILE\.platformio\penv\Scripts\platformio.exe" run -e esp32dev_RehabDevice -t buildfs
& "$env:USERPROFILE\.platformio\penv\Scripts\python.exe" scripts/check_static_assets.py
```

Close Serial Monitor before flashing both images. Filesystem upload replaces
LittleFS, including any locally stored database backup; preserve needed data first.

```powershell
& "$env:USERPROFILE\.platformio\penv\Scripts\platformio.exe" run -e esp32dev_RehabDevice -t upload
& "$env:USERPROFILE\.platformio\penv\Scripts\platformio.exe" run -e esp32dev_RehabDevice -t uploadfs
```

After connecting to the device Wi-Fi, verify actual HTTP headers and decompressed
body bytes for every asset, including games and module query strings:

```powershell
& "$env:USERPROFILE\.platformio\penv\Scripts\python.exe" scripts/check_static_assets.py --base-url http://rehab.local
curl.exe --noproxy "*" --compressed -i http://rehab.local/style.css
```

Use `http://192.168.4.1` if mDNS is unavailable. Expect HTTP 200, `text/css`,
`Content-Encoding: gzip`, `Cache-Control: no-cache, max-age=0, must-revalidate`,
and CSS beginning with `:root`, not HTML. In iPhone Safari, reopen the device
page and check the styled dashboard and each game. If an old cached page persists,
clear this site's data once. Confirm `/api/status`, `/ws`, and `/update` still
work; do not start an OTA upload just to test the page. A host-side build or
browser preview alone does not establish that the flashed device works on Safari.

#### Doctor dashboard regression checks

Run the synthetic-data browser suite (no hardware or destructive device commands):

```powershell
python -m pip install playwright
python -m playwright install chromium webkit
python -m unittest discover -s test -p test_doctor_dashboard.py -v
```

The suite checks both DOM-preservation sequences, CSV downloads, mocked deletion
confirmation, loading/error/pagination, norm validation and retention, progress
baselines, and storage availability. Chromium and WebKit check 320, 390, 430,
768, and 1280 CSS-pixel widths, overflow, metric styles, touch targets, sticky
header and input focus. Session history retains all eight columns and scrolls
inside its container on mobile; the default ALL view includes every patient.
The chart regression checks a visible bubble at smoothness 61 / amplitude 359.8,
dynamic Y-axis headroom (at least 180 degrees), invalid numeric inputs, and tab
reactivation. Screenshots are written to `.pio/dashboard-checks/`.
Readiness uses explicit UI assertions, never `networkidle`.

Run the angle boundary assertions with the installed ESP32 C++ compiler:

```powershell
& "$env:USERPROFILE\.platformio\packages\toolchain-xtensa-esp32\bin\xtensa-esp32-elf-g++.exe" -std=c++11 -Wall -Wextra -Werror -I include -fsyntax-only test/test_angle_normalization.cpp
```

These compile-time tests require no board or native host compiler. Calibrated
Euler differences are normalized to [-180, 180]; the shared helper accepts
differences of two angles in that range. Analytics accumulates shortest roll
steps into a continuous joint angle before calculating extrema and amplitude.
The +179/-179 regressions check both crossing directions without a false
358-degree span. Historical database records are not rewritten.

After `buildfs`, run the static-asset checker above. On hardware, also use its
`--base-url` option. Verify scrolling, search/norm keyboard focus, rotation and
safe areas in actual iPhone Safari; desktop WebKit does not emulate Safari's
browser chrome or the iOS keyboard. Filesystem flashing requires a database
backup and explicit operator approval; these tests never upload an image.

### Крок 3. Підключення та робота

1. Підключіться до Wi-Fi: **`RehabDevice_AP`** (пароль: **`rehab1234`**)
2. Відкриється **Captive Portal** автоматично (iOS / Android)
3. Або введіть вручну: **`http://192.168.4.1`**

---

## 🏗 Архітектура системи

### Прошивка (ESP32 / FreeRTOS)

Система побудована на **двоядерному FreeRTOS** з чітким розподілом задач:

| Задача | Ядро | Пріоритет | Призначення |
|---|---|---|---|
| `SensorTask` | Core 0 | 5 (вищий) | Очікування ISR від MPU DMP, читання FIFO |
| `DBTask` | Core 0 | 2 | Неблокуюче збереження сесій у SQLite |
| `loop()` (Arduino) | Core 1 | — | Обробка команд, трансляція даних через WebSocket |

**Міжзадачна комунікація:**
- `mpuDataQueue` (100 слотів) — сирі дані з гіроскопа
- `dbQueue` (10 слотів) — записи сесій для збереження
- `sysCommandQueue` (10 слотів) — команди з вебсервера у main loop

**Bluetooth вимкнено** при старті (`esp_bt_mem_release`) — звільняє ~110 КБ RAM.

---

### Підсистема сенсорики (`SensorMPU`)

- Використовує апаратний **DMP** (Digital Motion Processor) MPU6050 для обчислення кватерніонів і кутів Yaw/Pitch/**Roll** без навантаження ядра.
- ISR (`IRAM_ATTR`) сповіщає `SensorTask` через `vTaskNotifyGiveFromISR`.
- I²C: старт на 100 kHz → після ініціалізації DMP перемикається на **400 kHz**.
- Підтримує **миттєве рекалібрування** "на льоту" (знімає поточне положення як нульову точку).
- Фільтрація аномальних кватерніонів (перевірка `normSq` та `isnan`).
- Підтримка клонів: WHO_AM_I IDs `0x68`, `0x70`, `0x71`, `0x73`, `0x98`.

---

### Клінічний аналітичний рушій (`AnalyticsEngine`)

Обробляє **кожен пакет** (100 Гц) для точного виявлення подій:

| Показник | Метод |
|---|---|
| **Амплітуда** | `maxAngle − minAngle` за сесію |
| **Середня швидкість** | Векторна норма гіроскопа `√(gx²+gy²+gz²)` |
| **Плавність** | Починається з 100%, знижується на 1.5% за кожен spike |
| **Тремор/Ривок** | Кутове прискорення `d(ω)/dt > 300 °/s²` |
| **Кількість згинань** | Подвійний гістерезис 4° (ігнорує фізіологічний тремор) |
| **Тривалість сесії** | `millis()` від старту сесії |

Час сесії фіксується через **системний RTC** (`time(nullptr)`) після синхронізації з браузером при підключенні. Дата та час форматуються у `dd.mm.yyyy HH:MM:SS`.

---

### База даних (`DatabaseManager` + `SDManager`)

- **SQLite3** на SD-карті (`/sd/rehab.db`) або у LittleFS (`/littlefs/rehab.db`).
- **Авто-міграція**: при першому підключенні SD-карти дані з LittleFS автоматично переносяться в SD і LittleFS-копія видаляється.
- **Smart Retry**: до 3 спроб збереження з паузою 100–150 мс між ними (захист від тимчасового пропадання контактів картки).
- **SQLite busy timeout**: 1000 мс — якщо БД заблокована конкурентним читанням, запис зачекає.
- Оптимізації пам'яті: `SQLITE_CONFIG_MEMSTATUS=0`, `SQLITE_CONFIG_LOOKASIDE=0,0`.

**Схема таблиці `sessions`:**

```sql
CREATE TABLE IF NOT EXISTS sessions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_id      TEXT,
    timestamp       INTEGER,    -- Unix-час початку сесії
    date_str        TEXT,       -- "dd.mm.yyyy HH:MM:SS"
    min_angle       REAL,
    max_angle       REAL,
    amplitude       REAL,
    avg_speed       REAL,
    smoothness      REAL,
    flexions_count  INTEGER,
    session_duration REAL       -- секунди
);
```

---

### Вебсервер та API (`WebServerModule`)

- **ESPAsyncWebServer** на порту 80 — повністю неблокуючий.
- **ElegantOTA** — OTA-оновлення прошивки та LittleFS прямо з браузера (`/update`).

#### REST API

| Метод | Ендпоінт | Опис |
|---|---|---|
| GET | `/api/status` | Стан системи (JSON) |
| GET | `/api/sessions?offset=&limit=` | Пагінована вибірка сесій (**MessagePack**) |
| GET | `/api/cmd?action=...` | Команди: `startSession`, `stopSession`, `recalibrate`, `deletePatient`, `deleteSession`, `syncTime`, `reboot` |

#### WebSocket (`/ws`)

Двостороннє з'єднання. Сервер надсилає:

| Тип | Частота | Вміст |
|---|---|---|
| `angle` | ~20 Гц | Поточний кут roll (кожен 5-й пакет з 100 Гц) |
| `liveStats` | ≤5 Гц | Амплітуда, швидкість, плавність, кількість згинань |
| `status` | ~0.5 Гц | Стан сесії, версія прошивки, SD-статус |

Клієнт надсилає JSON-команди (ті ж, що й REST API).

#### Chunked MsgPack Streaming

Великі вибірки сесій передаються **чанками** через `AsyncChunkedSessionsResponse`:
- Клас реалізує `AsyncAbstractResponse` — дані пишуться у буфер поступово.
- MsgPack-заголовок масиву пишеться першим, далі — записи рядок за рядком з SQLite.
- Це захищає ESP32 від **OOM** та **TCP PCB exhaustion** при тисячах сесій.

---

### Wi-Fi та Captive Portal (`WiFiManagerModule`)

- Режим **SoftAP** з максимум 4 одночасними клієнтами.
- **Captive Portal**: перехоплення запитів `/generate_204`, `/hotspot-detect.html`, `connecttest.txt` тощо — автоматичне відкриття браузера на iOS/Android/Windows.

---

## 🖥 Веб-інтерфейс (SPA)

Однасторінковий застосунок на чистому **ES Modules JavaScript** без жодних фреймворків.

### Архітектура фронтенду

| Модуль | Призначення |
|---|---|
| `StateManager` | Реактивний стан (`subscribe/update/notify`), єдине джерело правди |
| `NetworkService` | WebSocket-з'єднання з автоматичним fallback на HTTP polling при розриві |
| `UIManager` | Весь рендеринг: вкладки, графіки (Chart.js Canvas API), таблиці, CSV-експорт |
| `GameEngine` | `requestAnimationFrame` loop, динамічне завантаження ігор, плавне інтерполювання кута |
| `app.js` | Точка входу, ініціалізація та OTA-логіка |

### Вкладка «Пацієнт (Тренування)»

- **Кругова індикація кута нахилу** — інтерактивний CSS-трансформ елемент.
- Реальний кут відображається у градусах (підтримка інверсії осі перемикачем).
- **Живі метрики сесії**: мін/макс кут, амплітуда, середня швидкість, плавність, кількість згинань, тривалість.
- Запуск/зупинка сесії з введенням імені пацієнта.
- **3 реабілітаційні ігри** (запускаються динамічно).

### Вкладка «Кабінет Лікаря»

- **Smart Search** — пошук пацієнтів та фільтрація за іменем.
- **Автономні графіки** (Chart.js) — динаміка прогресу (амплітуда, плавність, кількість згинань) без доступу до інтернету.
- **Оцінка відновлення %** — відсоток відносно цільової норми (наприклад, 90°).
- **CSV-експорт** — вся статистика у форматі Excel (`uFEFF` UTF-8 BOM для коректного відображення).
- Видалення сесій та пацієнтів.

### Вкладка «Налаштування»

- Рекалібрування гіроскопа в реальному часі.
- **OTA-оновлення** прямо з браузера:
  - Перевірка версії через GitHub Releases API (`To4ilochka/RehabDevice`).
  - Завантаження `firmware.bin` + `littlefs.bin` з GitHub та прошивка на пристрій.
  - Відображення прогрес-бару (окремо для FS і firmware).

---

## ⚙️ Таблиця розділів (partitions.csv)

| Розділ | Тип | Розмір | Призначення |
|---|---|---|---|
| `nvs` | data/nvs | 20 KB | Non-volatile storage |
| `otadata` | data/ota | 8 KB | OTA metadata |
| `app0` | app/ota_0 | 1536 KB | Основна прошивка (slot A) |
| `app1` | app/ota_1 | 1536 KB | OTA slot (slot B) |
| `spiffs` | data/spiffs | 896 KB | LittleFS (веб-інтерфейс) |
| `eeprom` | data | 4 KB | EEPROM |

---

## 📜 Ліцензія та авторство

Проєкт розроблено для клінічного застосування у сфері відновної медицини суглобів кисті.
Код оптимізовано з дотриманням стандартів надійності вбудованих систем IoT.
