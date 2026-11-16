const PROTOCOL_META = {
    0: {
        shortLabel: "↔ Кисть",
        name: "Кисть",
        csvName: "Кисть (2 напрямки)",
        normLabel: "🎯 Цільова норма суглоба:",
        normUnit: "град.",
        normMin: 10,
        normMax: 180,
        normDefault: "90",
        normError: "Введіть скінченне число від 10 до 180°.",
        recoveryLabel: "Амплітуда відносно цілі:"
    },
    1: {
        shortLabel: "🎯 Баланс: Статика",
        name: "Баланс: Статика",
        csvName: "Баланс: Статика",
        normLabel: "🎯 Цільова норма утримання (≤5°):",
        normUnit: "%",
        normMin: 10,
        normMax: 100,
        normDefault: "80",
        normError: "Введіть скінченне число від 10 до 100%.",
        recoveryLabel: "Стабільність відносно цілі:"
    },
    2: {
        shortLabel: "🎮 Баланс: Динаміка",
        name: "Баланс: Динаміка",
        csvName: "Баланс: Динаміка",
        normLabel: "🎯 Цільовий 2D розмах нахилу:",
        normUnit: "град.",
        normMin: 5,
        normMax: 45,
        normDefault: "25",
        normError: "Введіть скінченне число від 5 до 45°.",
        recoveryLabel: "Розмах відносно цілі:"
    }
};

export class UIManager {
    constructor(stateManager, networkService) {
        this.stateManager = stateManager;
        this.networkService = networkService;
        this.doctorChart = null;
        this.selectedDoctorPatient = "ALL";
        this.doctorSearchQuery = "";
        this.selectedDoctorProtocol = 0;
        this._protocolExplicitlyLocked = false;
        this._renderedNormProtocol = 0;
        this.targetNormByProtocol = {
            0: PROTOCOL_META[0].normDefault,
            1: PROTOCOL_META[1].normDefault,
            2: PROTOCOL_META[2].normDefault
        };
        this.allGameOptions = [];
        this.selectedGameByMode = {
            "two-direction": "pingpong",
            "four-direction": "balance3d"
        };
    }

    getSessionMode(rec) {
        const raw = Number(rec?.sessionMode);
        return (raw === 1 || raw === 2) ? raw : 0;
    }

    computeSymmetryPct(rec) {
        const explicit = Number(rec?.symmetryPct);
        if (Number.isFinite(explicit)) {
            return Math.max(0, Math.min(100, explicit));
        }
        const qFL = Number(rec?.qFL) || 0;
        const qFR = Number(rec?.qFR) || 0;
        const qBL = Number(rec?.qBL) || 0;
        const qBR = Number(rec?.qBR) || 0;
        const sum = qFL + qFR + qBL + qBR;
        if (!Number.isFinite(sum) || sum <= 0.001) return 0;
        const l1 = Math.abs(qFL - 25) + Math.abs(qFR - 25) + Math.abs(qBL - 25) + Math.abs(qBR - 25);
        return Math.max(0, Math.min(100, 100 * (1 - l1 / 150)));
    }

    init() {
        this.captureGameOptionsCatalog();
        this.initChart();
        this.setupTabNavigation();
        this.setupEventListeners();
        this.syncInputModeUI(this.stateManager.get('gameInputMode') || 'two-direction');

        const header = document.querySelector("header");
        if (header && typeof ResizeObserver !== "undefined") {
            this.headerObserver = new ResizeObserver(() => {
                document.documentElement.style.setProperty("--header-height", `${header.getBoundingClientRect().height}px`);
            });
            this.headerObserver.observe(header);
        }
        const keepDoctorInputVisible = () => requestAnimationFrame(() => {
            const input = document.activeElement;
            if (!input?.matches("#targetNormInput, #patientSearchInput")) return;
            const viewport = window.visualViewport;
            const top = Math.max(header?.getBoundingClientRect().bottom || 0, viewport?.offsetTop || 0);
            const bottom = (viewport?.offsetTop || 0) + (viewport?.height || window.innerHeight);
            const bounds = input.getBoundingClientRect();
            if (bounds.top < top || bounds.bottom > bottom) {
                window.scrollBy({ top: (bounds.top + bounds.bottom - top - bottom) / 2, behavior: "auto" });
            }
        });
        document.getElementById("tabDoctor").addEventListener("focusin", keepDoctorInputVisible);
        window.visualViewport?.addEventListener("resize", keepDoctorInputVisible);

        // Subscribe to state changes
        this.stateManager.subscribe('isConnected', (isConn) => {
            this.updateConnectionStatus(isConn, this.stateManager.get('isHttpFallback'));
            this.updateMemory();
        });

        this.stateManager.subscribe('isHttpFallback', (isFall) => {
            this.updateConnectionStatus(this.stateManager.get('isConnected'), isFall);
        });

        this.stateManager.subscribe('globalSdAvailable', () => this.updateMemory());
        this.stateManager.subscribe('storageLowSpace', () => this.updateMemory());

        this.stateManager.subscribe('isAuthorized', (isAuth) => this.toggleAuthUI(isAuth));
        this.stateManager.subscribe('activeSessionMode', () => {
            if (this.stateManager.get('isAuthorized')) {
                this.applyActiveSessionProtocolUI(true);
            }
        });

        this.stateManager.subscribe('balanceSubProtocol', (subProto) => {
            const sel = document.getElementById("balanceProtocolSelect");
            const normalized = subProto === "static" ? "static" : "dynamic";
            if (sel && sel.value !== normalized) {
                sel.value = normalized;
            }
        });

        this.stateManager.subscribe('currentFirmwareVersion', (version) => {
            const verElem = document.getElementById("currentFwVersion");
            if (verElem) verElem.textContent = version;
        });

        this.stateManager.subscribe('liveStats', (stats) => {
            if (stats) this.updateLiveStats(stats);
        });

        this.stateManager.subscribe('memoryUsage', (mem) => this.updateMemory(mem));

        this.stateManager.subscribe('targetAngle', (angle) => {
            const formatted = Number.isFinite(angle) ? angle.toFixed(1) : "0.0";
            const valElem = document.getElementById("angleValueElem");
            if (valElem) valElem.textContent = formatted;
            const rollElem = document.getElementById("rollValueElem");
            if (rollElem) rollElem.textContent = formatted;
        });

        this.stateManager.subscribe('targetPitch', (pitch) => {
            const formatted = Number.isFinite(pitch) ? pitch.toFixed(1) : "0.0";
            const pitchElem = document.getElementById("pitchValueElem");
            if (pitchElem) pitchElem.textContent = formatted;
        });

        this.stateManager.subscribe('gameInputMode', (mode) => {
            this.syncInputModeUI(mode);
        });

        this.stateManager.subscribe('invertAxes', (inverted) => {
            const el = document.getElementById("invertAngleToggle");
            if (el) el.checked = Boolean(inverted);
        });

        this.stateManager.subscribe('invertPitch', (inverted) => {
            const el = document.getElementById("invertPitchToggle");
            if (el) el.checked = Boolean(inverted);
        });

        this.stateManager.subscribe('swapAxes', (swapped) => {
            const el = document.getElementById("swapAxesToggle");
            if (el) el.checked = Boolean(swapped);
        });

        this.stateManager.subscribe('currentPatientName', (name) => {
            const el = document.getElementById("activePatientName");
            if (el) el.textContent = name;
        });
    }

    captureGameOptionsCatalog() {
        const gameSelect = document.getElementById("gameSelect");
        if (!gameSelect) return;
        const parsed = [...gameSelect.options].map(opt => ({
            value: opt.value,
            label: opt.textContent,
            directions: Number(opt.dataset.directions) >= 4 ? 4 : 2,
            style: opt.getAttribute("style") || "color: #ffffff;"
        }));
        if (parsed.length > 0) {
            this.allGameOptions = parsed;
        }
    }

    syncInputModeUI(mode) {
        const normalizedMode = mode === "four-direction" ? "four-direction" : "two-direction";
        const isFourWay = normalizedMode === "four-direction";
        const targetDirections = isFourWay ? 4 : 2;

        const modeSelect = document.getElementById("gameInputMode");
        if (modeSelect && modeSelect.value !== normalizedMode) {
            modeSelect.value = normalizedMode;
        }

        const fourWayProtoGroup = document.getElementById("fourWayProtocolGroup");
        if (fourWayProtoGroup) {
            fourWayProtoGroup.hidden = !isFourWay;
        }

        const protoSelect = document.getElementById("balanceProtocolSelect");
        if (protoSelect) {
            const subProto = this.stateManager.get('balanceSubProtocol') === "static" ? "static" : "dynamic";
            if (protoSelect.value !== subProto) {
                protoSelect.value = subProto;
            }
        }

        const gameSelect = document.getElementById("gameSelect");
        if (gameSelect && this.allGameOptions.length > 0) {
            const currentOption = this.allGameOptions.find(opt => opt.value === gameSelect.value);
            if (currentOption) {
                const prevKey = currentOption.directions >= 4 ? "four-direction" : "two-direction";
                this.selectedGameByMode[prevKey] = currentOption.value;
            }

            const allowedOptions = this.allGameOptions.filter(opt => opt.directions === targetDirections);
            const preferredValue = this.selectedGameByMode[normalizedMode];
            const nextValue = allowedOptions.some(opt => opt.value === preferredValue)
                ? preferredValue
                : (allowedOptions[0]?.value || "");

            gameSelect.innerHTML = "";
            allowedOptions.forEach(item => {
                const opt = document.createElement("option");
                opt.value = item.value;
                opt.dataset.directions = String(item.directions);
                opt.setAttribute("style", item.style);
                opt.textContent = item.label;
                if (item.value === nextValue) {
                    opt.selected = true;
                }
                gameSelect.appendChild(opt);
            });
            if (nextValue) {
                gameSelect.value = nextValue;
                this.selectedGameByMode[normalizedMode] = nextValue;
            }
        }

        const gameSelectLabel = document.getElementById("gameSelectLabel");
        if (gameSelectLabel) {
            gameSelectLabel.textContent = isFourWay
                ? "Оберіть гру (4 напрямки)"
                : "Оберіть гру (2 напрямки)";
        }

        const fourWayOrientation = document.getElementById("fourWayOrientationControls");
        if (fourWayOrientation) {
            fourWayOrientation.hidden = !isFourWay;
        }

        const visualizerTitle = document.getElementById("visualizerTitle");
        if (visualizerTitle) {
            visualizerTitle.textContent = isFourWay
                ? "🧭 Візуалізація нахилу баланс-дошки (360°)"
                : "🔄 Динамічна візуалізація кута кисті";
        }

        const circleIndicator = document.getElementById("circleIndicator");
        if (circleIndicator) circleIndicator.hidden = isFourWay;

        const balanceBoardVisualizer = document.getElementById("balanceBoardVisualizer");
        if (balanceBoardVisualizer) balanceBoardVisualizer.hidden = !isFourWay;

        const singleReadout = document.getElementById("singleAngleReadout");
        if (singleReadout) singleReadout.hidden = isFourWay;

        const dualReadout = document.getElementById("dualAngleReadout");
        if (dualReadout) dualReadout.hidden = !isFourWay;
    }

    updateConnectionStatus(isConnected, isHttpFallback) {
        const dot = document.getElementById("statusDot");
        const text = document.getElementById("statusText");

        if (!dot || !text) return;

        if (isConnected) {
            dot.classList.add("connected");
            text.textContent = isHttpFallback ? "Пристрій підключено (HTTP)" : "Пристрій підключено";
            text.style.color = "";
        } else {
            dot.classList.remove("connected");
            text.textContent = isHttpFallback ? "Відключено (очікування HTTP...)" : "Відключено (перепідключення...)";
        }
    }

    updateMemory() {
        const memoryText = document.getElementById("memoryText");
        const memoryLabel = document.getElementById("memoryTypeLabel");
        const isConnected = this.stateManager.get('isConnected');
        const isSdAvailable = this.stateManager.get('globalSdAvailable');
        const lowSpace = Boolean(this.stateManager.get('storageLowSpace'));

        if (memoryLabel) {
            memoryLabel.textContent = "Сховище";
        }
        if (memoryText) {
            if (!isConnected || isSdAvailable == null) {
                memoryText.textContent = "Стан невідомий";
                memoryText.style.color = "";
            } else if (!isSdAvailable && lowSpace) {
                memoryText.textContent = "Пам'ять заповнена (<100 КБ)";
                memoryText.style.color = "var(--accent-red)";
            } else {
                memoryText.textContent = isSdAvailable ? "SD-карта доступна" : "SD-карта відсутня";
                memoryText.style.color = "";
            }
        }
    }

    applyActiveSessionProtocolUI(isAuthorized) {
        const modeSelect = document.getElementById("gameInputMode");
        const protoSelect = document.getElementById("balanceProtocolSelect");
        const launchGroup = document.getElementById("activeGameLaunchGroup");
        const staticHint = document.getElementById("staticHoldActiveHint");

        const locked = Boolean(isAuthorized);
        if (modeSelect) modeSelect.disabled = locked;
        if (protoSelect) protoSelect.disabled = locked;

        if (locked) {
            const activeMode = this.getSessionMode({ sessionMode: this.stateManager.get('activeSessionMode') });
            if (launchGroup) launchGroup.hidden = (activeMode === 1);
            if (staticHint) staticHint.hidden = (activeMode !== 1);
            this.configureLiveStatsLabels(activeMode);
        } else {
            if (launchGroup) launchGroup.hidden = false;
            if (staticHint) staticHint.hidden = true;
        }
    }

    toggleAuthUI(isAuthorized) {
        const guestPanel = document.getElementById("authGuestPanel");
        const activePanel = document.getElementById("authActivePanel");
        const liveStats = document.getElementById("liveStatsPanel");
        const patientInput = document.getElementById("patientIdInput");

        this.applyActiveSessionProtocolUI(isAuthorized);

        if (isAuthorized) {
            if (guestPanel) guestPanel.style.display = "none";
            if (activePanel) activePanel.style.display = "flex";
            if (liveStats) liveStats.style.display = "block";
        } else {
            if (guestPanel) guestPanel.style.display = "flex";
            if (activePanel) activePanel.style.display = "none";
            if (liveStats) liveStats.style.display = "none";
            if (patientInput) patientInput.value = "";
        }
    }

    configureLiveStatsLabels(mode) {
        const t1 = document.getElementById("statTitle1");
        const t2 = document.getElementById("statTitle2");
        const t3 = document.getElementById("statTitle3");
        const t4 = document.getElementById("statTitle4");
        const t5 = document.getElementById("statTitle5");
        const t6 = document.getElementById("statTitle6");
        if (t6) t6.textContent = "Тривалість сесії";

        if (mode === 1) {
            if (t1) t1.textContent = "Відхилення Sway RMS";
            if (t2) t2.textContent = "Утримання центру (≤5°)";
            if (t3) t3.textContent = "Швидкість нахилу";
            if (t4) t4.textContent = "Індекс плавності";
            if (t5) t5.textContent = "Центр балансу (R / P)";
        } else if (mode === 2) {
            if (t1) t1.textContent = "Діапазон ML / AP";
            if (t2) t2.textContent = "2D Розмах нахилу";
            if (t3) t3.textContent = "Швидкість нахилу";
            if (t4) t4.textContent = "Індекс плавності";
            if (t5) t5.textContent = "Симетрія 4 квадрантів";
        } else {
            if (t1) t1.textContent = "Мін / Макс Кут";
            if (t2) t2.textContent = "Амплітуда руху";
            if (t3) t3.textContent = "Сер. швидкість";
            if (t4) t4.textContent = "Індекс плавності (тремор)";
            if (t5) t5.textContent = "Згинання / Повороти";
        }
    }

    updateLiveStats(data) {
        const mode = this.getSessionMode(data);
        this.configureLiveStatsLabels(mode);

        const statMin = document.getElementById("statMin");
        const statSep = document.getElementById("statSep");
        const statMax = document.getElementById("statMax");
        const statAmp = document.getElementById("statAmp");
        const statSpeed = document.getElementById("statSpeed");
        const statSmooth = document.getElementById("statSmooth");
        const statFlex = document.getElementById("statFlex");
        const statDuration = document.getElementById("statDuration");

        const minAngle = Number(data.minAngle) || 0;
        const maxAngle = Number(data.maxAngle) || 0;
        const amp = Number(data.amplitude) || 0;
        const speed = Number(data.avgSpeed) || 0;
        const smooth = Number(data.smoothness) || 0;
        const duration = Number(data.sessionDuration) || 0;

        if (mode === 1) {
            const swayRms = Number(data.swayRms) || 0;
            const mlRms = Number(data.mlRms) || 0;
            const apRms = Number(data.apRms) || 0;
            const stability = Number(data.stabilityPct) || 0;
            const meanRoll = Number(data.meanRoll) || 0;
            const meanPitch = Number(data.meanPitch) || 0;

            if (statMin) statMin.textContent = `${swayRms.toFixed(1)}°`;
            if (statSep) statSep.textContent = " · ";
            if (statMax) statMax.textContent = `${mlRms.toFixed(1)}°/${apRms.toFixed(1)}°`;
            if (statAmp) statAmp.textContent = `${stability.toFixed(0)}%`;
            if (statFlex) statFlex.textContent = `${meanRoll.toFixed(1)}° / ${meanPitch.toFixed(1)}°`;
        } else if (mode === 2) {
            const mlSpan = Math.max(0, maxAngle - minAngle);
            const minPitch = Number(data.minPitch) || 0;
            const maxPitch = Number(data.maxPitch) || 0;
            const apSpan = Math.max(0, maxPitch - minPitch);
            const sym = this.computeSymmetryPct(data);

            if (statMin) statMin.textContent = `${mlSpan.toFixed(1)}°`;
            if (statSep) statSep.textContent = " / ";
            if (statMax) statMax.textContent = `${apSpan.toFixed(1)}°`;
            if (statAmp) statAmp.textContent = `${amp.toFixed(1)}°`;
            if (statFlex) statFlex.textContent = `${sym.toFixed(0)}%`;
        } else {
            if (statMin) statMin.textContent = `${minAngle.toFixed(1)}°`;
            if (statSep) statSep.textContent = " / ";
            if (statMax) statMax.textContent = `${maxAngle.toFixed(1)}°`;
            if (statAmp) statAmp.textContent = `${amp.toFixed(1)}°`;
            if (statFlex) statFlex.textContent = `${Number(data.flexionsCount) || 0}`;
        }

        if (statSpeed) statSpeed.textContent = `${speed.toFixed(1)}°/с`;
        if (statSmooth) statSmooth.textContent = `${smooth.toFixed(0)}%`;
        if (statDuration) statDuration.textContent = `${duration.toFixed(1)} с`;
    }

    setupTabNavigation() {
        const tabBtns = document.querySelectorAll(".tab-btn");
        const tabContents = document.querySelectorAll(".tab-content");

        tabBtns.forEach(btn => {
            btn.addEventListener("click", () => {
                tabBtns.forEach(b => b.classList.remove("active"));
                tabContents.forEach(c => c.classList.remove("active"));

                btn.classList.add("active");
                const targetId = btn.getAttribute("data-tab");
                document.getElementById(targetId).classList.add("active");

                if (targetId === "tabDoctor") {
                    this.updateDoctorDashboardView();
                    this.networkService.fetchAllSessionsPaginated();
                    requestAnimationFrame(() => {
                        if (document.getElementById(targetId).classList.contains("active") && this.doctorChart) {
                            this.doctorChart.resize();
                            this.doctorChart.update('none');
                        }
                    });
                }
            });
        });

        window.addEventListener("resize", () => {
            if (document.getElementById("tabDoctor") && document.getElementById("tabDoctor").classList.contains("active")) {
                this.updateDoctorDashboardView();
            }
        });
    }

    setupEventListeners() {
        const btnStart = document.getElementById("btnStartSession");
        if (btnStart) {
            btnStart.addEventListener("click", () => {
                const input = document.getElementById("patientIdInput");
                const name = input.value.trim();
                if (!name) {
                    alert("Будь ласка, введіть ПІБ пацієнта для початку сесії.");
                    return;
                }

                if (!this.stateManager.get('globalSdAvailable') && this.stateManager.get('storageLowSpace')) {
                    alert("⛔ Недостатньо вільної пам'яті на пристрої (< 100 КБ), а SD-карта відсутня. Сесію заблоковано, щоб зберегти несинхронізовані дані пацієнтів. Вставте SD-карту для автоматичного перенесення архіву.");
                    return;
                }

                const modeSelect = document.getElementById("gameInputMode");
                const protoSelect = document.getElementById("balanceProtocolSelect");
                const inputMode = modeSelect?.value === "four-direction" ? "four-direction" : "two-direction";
                const subProto = protoSelect?.value === "static" ? "static" : "dynamic";
                const sessionMode = inputMode === "two-direction" ? 0 : (subProto === "static" ? 1 : 2);

                const invertX = Boolean(document.getElementById("invertAngleToggle")?.checked);
                const invertY = Boolean(document.getElementById("invertPitchToggle")?.checked);
                const swapAxes = Boolean(document.getElementById("swapAxesToggle")?.checked);
                const engine = window.engineInstance;
                const tareRoll = Number(engine?.input?.rollTare) || 0;
                const tarePitch = Number(engine?.input?.pitchTare) || 0;

                this.networkService.sendCommand("startSession", {
                    patientId: name,
                    sessionMode,
                    invertX,
                    invertY,
                    swapAxes,
                    tareRoll,
                    tarePitch
                });

                this.stateManager.updateMultiple({
                    activeSessionMode: sessionMode,
                    gameInputMode: inputMode,
                    balanceSubProtocol: subProto,
                    isAuthorized: true,
                    currentPatientName: name
                });

                // Extract 2-way wrist baseline calibration from Wrist history only
                let calibMin = -20;
                let calibMax = 20;
                const allSessionsData = this.stateManager.get('allSessionsData');
                if (allSessionsData) {
                    const patientWristSessions = allSessionsData.filter(
                        s => s.patientId === name && this.getSessionMode(s) === 0
                    );
                    if (patientWristSessions.length > 0) {
                        patientWristSessions.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
                        const last = patientWristSessions[0];
                        if (last.minAngle !== undefined && last.maxAngle !== undefined) {
                            let min = parseFloat(last.minAngle) || 0;
                            let max = parseFloat(last.maxAngle) || 0;
                            if (max - min < 10) { min -= 5; max += 5; }
                            calibMin = min;
                            calibMax = max;
                        }
                    }
                }
                this.stateManager.updateMultiple({ calibMin, calibMax });
            });
        }

        const btnStop = document.getElementById("btnStopSession");
        if (btnStop) {
            btnStop.addEventListener("click", () => {
                const engine = window.engineInstance;
                if (engine) engine.stopGame();
                this.networkService.sendCommand("stopSession");
                this.stateManager.update('isAuthorized', false);
                setTimeout(() => this.networkService.fetchAllSessionsPaginated(), 500);
            });
        }

        const btnRecalibrate = document.getElementById("btnRecalibrate");
        if (btnRecalibrate) {
            btnRecalibrate.addEventListener("click", () => {
                this.networkService.sendCommand("recalibrate");
                window.engineInstance?.resetTare();
                if (!btnRecalibrate.dataset.originalLabel) {
                    btnRecalibrate.dataset.originalLabel = btnRecalibrate.textContent;
                }
                btnRecalibrate.textContent = "⏳ Калібрується 0°...";
                clearTimeout(this._recalTimer);
                this._recalTimer = setTimeout(() => {
                    btnRecalibrate.textContent = btnRecalibrate.dataset.originalLabel;
                }, 1200);
            });
        }

        const searchInput = document.getElementById("patientSearchInput");
        const exactSearchBtn = document.getElementById("btnExactSearch");

        const performExactSearch = () => {
            if (!searchInput) return;
            const query = searchInput.value.trim();
            if (query.length === 0) {
                this.selectPatientByPill("ALL", true);
            } else {
                this._protocolExplicitlyLocked = false;
                this.updateDoctorDashboardView(query, true);
            }
        };

        if (exactSearchBtn) exactSearchBtn.addEventListener("click", performExactSearch);
        if (searchInput) {
            searchInput.addEventListener("keydown", (e) => {
                if (e.key === "Enter" && !e.isComposing) performExactSearch();
            });
        }

        document.querySelectorAll("#doctorProtocolSwitch .protocol-pill").forEach(btn => {
            btn.addEventListener("click", () => {
                const proto = Number(btn.getAttribute("data-protocol")) || 0;
                this.selectDoctorProtocol(proto, true);
            });
        });

        const btnDeletePatient = document.getElementById("btnDeletePatient");
        if (btnDeletePatient) {
            btnDeletePatient.addEventListener("click", () => {
                if (this.selectedDoctorPatient === "ALL") return;
                const result = confirm(`Ви дійсно хочете безповоротно видалити ВСІ записи пацієнта «${this.selectedDoctorPatient}» з флеш-пам'яті пристрою?`);
                if (result) {
                    this.networkService.sendCommand("deletePatient", { patientId: this.selectedDoctorPatient });
                    this.selectPatientByPill("ALL", true);
                    setTimeout(() => this.networkService.fetchAllSessionsPaginated(), 1000);
                }
            });
        }

        const btnDownloadCSV = document.getElementById("btnDownloadCSV");
        if (btnDownloadCSV) {
            btnDownloadCSV.addEventListener("click", () => {
                this.downloadCSV(this.stateManager.get('allSessionsData') || [], "All_Patients_Sessions.csv");
            });
        }

        const btnDownloadClientCSV = document.getElementById("btnDownloadClientCSV");
        if (btnDownloadClientCSV) {
            btnDownloadClientCSV.addEventListener("click", () => {
                if (this.selectedDoctorPatient === "ALL") {
                    alert("Будь ласка, оберіть конкретного пацієнта.");
                    return;
                }
                const all = this.stateManager.get('allSessionsData') || [];
                const filtered = all.filter(s => (s.patientId || "").trim() === this.selectedDoctorPatient);
                this.downloadCSV(filtered, `${this.selectedDoctorPatient}_Sessions.csv`);
            });
        }

        const normInput = document.getElementById("targetNormInput");
        if (normInput) {
            normInput.addEventListener("input", () => this.updateDoctorDashboardView());
        }

        document.getElementById("btnShowAllPatients")?.addEventListener("click", () => this.selectPatientByPill("ALL", true));
        document.getElementById("btnRetrySessions")?.addEventListener("click", () => this.networkService.fetchAllSessionsPaginated());

        const btnModeGame = document.getElementById("btnModeGame");
        const btnExitGame = document.getElementById("btnExitGame");
        const gameContainer = document.getElementById("gameContainer");
        const gameInputMode = document.getElementById("gameInputMode");
        const balanceProtocolSelect = document.getElementById("balanceProtocolSelect");
        const gameSelect = document.getElementById("gameSelect");
        const btnTareGameInput = document.getElementById("btnTareGameInput");
        const invertAngleToggle = document.getElementById("invertAngleToggle");
        const invertPitchToggle = document.getElementById("invertPitchToggle");
        const swapAxesToggle = document.getElementById("swapAxesToggle");

        const syncOrientationFromDOM = () => {
            const invertX = Boolean(invertAngleToggle?.checked);
            const invertY = Boolean(invertPitchToggle?.checked);
            const swapAxes = Boolean(swapAxesToggle?.checked);
            window.engineInstance?.setAxisOrientation({ invertX, invertY, swapAxes });
            const tareRoll = Number(window.engineInstance?.input?.rollTare) || 0;
            const tarePitch = Number(window.engineInstance?.input?.pitchTare) || 0;
            this.networkService.sendCommand("syncOrientation", {
                invertX,
                invertY,
                swapAxes,
                tareRoll,
                tarePitch
            });
        };

        invertAngleToggle?.addEventListener("change", syncOrientationFromDOM);
        invertPitchToggle?.addEventListener("change", syncOrientationFromDOM);
        swapAxesToggle?.addEventListener("change", syncOrientationFromDOM);

        balanceProtocolSelect?.addEventListener("change", () => {
            const val = balanceProtocolSelect.value === "static" ? "static" : "dynamic";
            this.stateManager.update('balanceSubProtocol', val);
        });

        gameSelect?.addEventListener("change", () => {
            const currentMode = this.stateManager.get('gameInputMode') === 'four-direction'
                ? 'four-direction'
                : 'two-direction';
            if (gameSelect.value) {
                this.selectedGameByMode[currentMode] = gameSelect.value;
            }
        });

        gameInputMode?.addEventListener("change", () => {
            if (window.engineInstance) {
                window.engineInstance.setInputMode(gameInputMode.value);
            } else {
                this.stateManager.update('gameInputMode', gameInputMode.value);
            }
        });

        btnTareGameInput?.addEventListener("click", () => {
            window.engineInstance?.tareInput();
            const tareRoll = Number(window.engineInstance?.input?.rollTare) || 0;
            const tarePitch = Number(window.engineInstance?.input?.pitchTare) || 0;
            this.networkService.sendCommand("setTare", { tareRoll, tarePitch });
            if (!btnTareGameInput.dataset.originalLabel) {
                btnTareGameInput.dataset.originalLabel = btnTareGameInput.textContent;
            }
            btnTareGameInput.textContent = "✅ 0° Відцентровано";
            clearTimeout(this._tareTimer);
            this._tareTimer = setTimeout(() => {
                btnTareGameInput.textContent = btnTareGameInput.dataset.originalLabel;
            }, 900);
        });

        if (btnModeGame) {
            btnModeGame.addEventListener("click", () => {
                if (this.stateManager.get('isAuthorized') && Number(this.stateManager.get('activeSessionMode')) === 1) {
                    return;
                }
                this.stateManager.update('currentAppMode', 'game');
                if (gameContainer) gameContainer.style.display = "flex";
                const engine = window.engineInstance;
                if (gameSelect && engine && gameSelect.value) {
                    engine.startGame(gameSelect.value);
                }
            });
        }

        if (btnExitGame) {
            btnExitGame.addEventListener("click", () => {
                const engine = window.engineInstance;
                if (engine) engine.stopGame();
            });
        }
    }

    selectDoctorProtocol(proto, explicit = false) {
        const nextProto = (proto === 1 || proto === 2) ? proto : 0;
        this.selectedDoctorProtocol = nextProto;
        if (explicit) {
            this._protocolExplicitlyLocked = true;
            this.updateDoctorDashboardView();
        }
    }

    syncProtocolSwitchButtons(protoCounts, visible) {
        const strip = document.getElementById("doctorProtocolSwitch");
        if (!strip) return;
        if (strip.hidden !== !visible) {
            strip.hidden = !visible;
        }
        strip.querySelectorAll(".protocol-pill").forEach(btn => {
            const p = Number(btn.getAttribute("data-protocol")) || 0;
            const meta = PROTOCOL_META[p] || PROTOCOL_META[0];
            const isActive = p === this.selectedDoctorProtocol;
            const pressedStr = String(isActive);
            const nextText = `${meta.shortLabel} (${protoCounts[p] || 0})`;
            btn.classList.toggle("active", isActive);
            if (btn.getAttribute("aria-pressed") !== pressedStr) {
                btn.setAttribute("aria-pressed", pressedStr);
            }
            if (btn.textContent !== nextText) {
                btn.textContent = nextText;
            }
        });
    }

    syncNormInputForProtocol(proto) {
        const normInput = document.getElementById("targetNormInput");
        if (!normInput) return { targetNorm: NaN, validNorm: false };

        const meta = PROTOCOL_META[proto] || PROTOCOL_META[0];
        if (this._renderedNormProtocol !== proto) {
            this.targetNormByProtocol[this._renderedNormProtocol] = normInput.value;
            this._renderedNormProtocol = proto;
            normInput.min = String(meta.normMin);
            normInput.max = String(meta.normMax);
            normInput.value = this.targetNormByProtocol[proto] ?? meta.normDefault;
        } else {
            normInput.min = String(meta.normMin);
            normInput.max = String(meta.normMax);
        }

        const normLabel = document.getElementById("targetNormLabel");
        if (normLabel) normLabel.textContent = meta.normLabel;
        const normUnit = document.getElementById("targetNormUnit");
        if (normUnit) normUnit.textContent = meta.normUnit;
        const recLabel = document.getElementById("recoveryIndexLabel");
        if (recLabel) recLabel.textContent = meta.recoveryLabel;
        const errElem = document.getElementById("targetNormError");
        if (errElem) errElem.textContent = meta.normError;

        const targetNorm = normInput.valueAsNumber;
        const validNorm = Number.isFinite(targetNorm) && targetNorm >= meta.normMin && targetNorm <= meta.normMax;
        normInput.setCustomValidity(validNorm ? "" : meta.normError);
        normInput.setAttribute("aria-invalid", String(!validNorm));
        if (errElem) errElem.hidden = validNorm;

        return { targetNorm, validNorm };
    }

    renderPatientPills(sessions) {
        const container = document.getElementById("patientPillsContainer");
        if (!container) return;

        const counts = {};
        sessions.forEach(s => {
            const name = (s.patientId || "Пацієнт").trim();
            counts[name] = (counts[name] || 0) + 1;
        });

        const uniquePatients = Object.keys(counts).sort((a, b) => a.localeCompare(b, "uk"));
        const signature = JSON.stringify([sessions.length, ...uniquePatients.map(n => [n, counts[n]])]);

        if (this._patientPillsSignature === signature && container.children.length === uniquePatients.length + 1) {
            container.querySelectorAll(".patient-pill").forEach(btn => {
                btn.classList.toggle("active", btn.getAttribute("data-patient") === this.selectedDoctorPatient);
            });
            return;
        }
        this._patientPillsSignature = signature;

        container.innerHTML = "";
        const fragment = document.createDocumentFragment();

        const allBtn = document.createElement("button");
        allBtn.type = "button";
        allBtn.className = `patient-pill${this.selectedDoctorPatient === "ALL" ? " active" : ""}`;
        allBtn.setAttribute("data-patient", "ALL");
        allBtn.textContent = `🧑 Всі пацієнти (${sessions.length})`;
        allBtn.onclick = () => this.selectPatientByPill("ALL", true);
        fragment.appendChild(allBtn);

        uniquePatients.forEach(name => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = `patient-pill${this.selectedDoctorPatient === name ? " active" : ""}`;
            btn.setAttribute("data-patient", name);
            btn.textContent = `👤 ${name} (${counts[name]})`;
            btn.onclick = () => this.selectPatientByPill(name, true);
            fragment.appendChild(btn);
        });

        container.appendChild(fragment);
    }

    selectPatientByPill(patientName, triggerUpdate = true) {
        if (this.selectedDoctorPatient !== patientName) {
            this._protocolExplicitlyLocked = false;
        }
        this.selectedDoctorPatient = patientName;
        this.doctorSearchQuery = "";

        document.querySelectorAll(".patient-pill").forEach(btn => {
            if (btn.getAttribute("data-patient") === patientName) {
                btn.classList.add("active");
            } else {
                btn.classList.remove("active");
            }
        });

        const searchInput = document.getElementById("patientSearchInput");
        if (searchInput && triggerUpdate) searchInput.value = "";

        if (triggerUpdate) this.updateDoctorDashboardView();
    }

    updateBalanceQuadrantWidget(chrono, latest) {
        const widget = document.getElementById("balanceQuadrantWidget");
        if (!widget) return;
        widget.hidden = false;

        const qFL = Math.max(0, Math.min(100, Number(latest.qFL) || 0));
        const qFR = Math.max(0, Math.min(100, Number(latest.qFR) || 0));
        const qBL = Math.max(0, Math.min(100, Number(latest.qBL) || 0));
        const qBR = Math.max(0, Math.min(100, Number(latest.qBR) || 0));
        const symPct = this.computeSymmetryPct(latest);

        const setSector = (sectorId, valId, pct) => {
            const sec = document.getElementById(sectorId);
            if (sec) {
                const alpha = Math.max(0.06, Math.min(0.62, 0.06 + (pct / 100) * 0.52));
                sec.style.fill = `rgba(0, 242, 254, ${alpha.toFixed(2)})`;
            }
            const valEl = document.getElementById(valId);
            if (valEl) valEl.textContent = `${Math.round(pct)}%`;
        };

        setSector("quadSectorFL", "quadValFL", qFL);
        setSector("quadSectorFR", "quadValFR", qFR);
        setSector("quadSectorBL", "quadValBL", qBL);
        setSector("quadSectorBR", "quadValBR", qBR);

        const mapCob = (meanRoll, meanPitch) => {
            const fullScaleDeg = 15;
            const maxRadiusPx = 62;
            let nx = (Number(meanRoll) || 0) / fullScaleDeg;
            let ny = (Number(meanPitch) || 0) / fullScaleDeg;
            const mag = Math.hypot(nx, ny);
            if (mag > 1) {
                nx /= mag;
                ny /= mag;
            }
            return {
                cx: 80 + nx * maxRadiusPx,
                cy: 80 - ny * maxRadiusPx
            };
        };

        const latestMeanRoll = Number(latest.meanRoll) || 0;
        const latestMeanPitch = Number(latest.meanPitch) || 0;
        const courseMeanRoll = chrono.reduce((sum, s) => sum + (Number(s.meanRoll) || 0), 0) / Math.max(1, chrono.length);
        const courseMeanPitch = chrono.reduce((sum, s) => sum + (Number(s.meanPitch) || 0), 0) / Math.max(1, chrono.length);

        const latestPt = mapCob(latestMeanRoll, latestMeanPitch);
        const coursePt = mapCob(courseMeanRoll, courseMeanPitch);

        const latestDot = document.getElementById("quadLatestCobDot");
        if (latestDot) {
            latestDot.setAttribute("cx", latestPt.cx.toFixed(1));
            latestDot.setAttribute("cy", latestPt.cy.toFixed(1));
        }
        const courseDot = document.getElementById("quadCourseCobDot");
        if (courseDot) {
            courseDot.setAttribute("cx", coursePt.cx.toFixed(1));
            courseDot.setAttribute("cy", coursePt.cy.toFixed(1));
        }

        const cobText = document.getElementById("quadCobSummaryText");
        if (cobText) {
            const rSign = latestMeanRoll > 0 ? "+" : "";
            const pSign = latestMeanPitch > 0 ? "+" : "";
            cobText.textContent = `Зміщення CoB: Roll ${rSign}${latestMeanRoll.toFixed(1)}°, Pitch ${pSign}${latestMeanPitch.toFixed(1)}° · Симетрія: ${Math.round(symPct)}%`;
        }
    }

    updateDoctorDashboardView(searchQuery = "", isExactSearch = false) {
        const filterLabel = document.getElementById("tableFilterLabel");
        const summaryBox = document.getElementById("patientSummaryContainer");
        const quadrantWidget = document.getElementById("balanceQuadrantWidget");
        const allSessionsData = this.stateManager.get('allSessionsData') || [];
        if (isExactSearch) this.doctorSearchQuery = searchQuery.trim();

        let patientScoped = allSessionsData;
        if (this.doctorSearchQuery) {
            const query = this.doctorSearchQuery.toLowerCase();
            patientScoped = allSessionsData.filter(s => (s.patientId || "").trim().toLowerCase() === query);
            if (patientScoped.length === 0) {
                patientScoped = allSessionsData.filter(s => (s.patientId || "").trim().toLowerCase().includes(query));
            }
            const names = new Set(patientScoped.map(session => (session.patientId || "Пацієнт").trim()));
            this.selectedDoctorPatient = names.size === 1 ? [...names][0] : "ALL";
        } else if (this.selectedDoctorPatient && this.selectedDoctorPatient !== "ALL") {
            patientScoped = allSessionsData.filter(s => (s.patientId || "Пацієнт").trim() === this.selectedDoctorPatient);
        }

        document.querySelectorAll(".patient-pill").forEach(btn => {
            btn.classList.toggle("active", btn.getAttribute("data-patient") === this.selectedDoctorPatient);
        });

        const protoCounts = [0, 0, 0];
        patientScoped.forEach(s => {
            protoCounts[this.getSessionMode(s)]++;
        });

        if (!this._protocolExplicitlyLocked && patientScoped.length > 0 && protoCounts[this.selectedDoctorProtocol] === 0) {
            const fallbackProto = [0, 1, 2].find(p => protoCounts[p] > 0);
            if (fallbackProto !== undefined) {
                this.selectedDoctorProtocol = fallbackProto;
            }
        }

        const proto = this.selectedDoctorProtocol;
        const protoMeta = PROTOCOL_META[proto] || PROTOCOL_META[0];
        const filtered = patientScoped.filter(s => this.getSessionMode(s) === proto);

        if (filterLabel) {
            if (this.doctorSearchQuery) {
                filterLabel.textContent = `(Пошук: «${this.doctorSearchQuery}» — знайдено: ${filtered.length})`;
            } else if (this.selectedDoctorPatient && this.selectedDoctorPatient !== "ALL") {
                filterLabel.textContent = `(Пацієнт: ${this.selectedDoctorPatient} · ${protoMeta.name})`;
            } else {
                filterLabel.textContent = proto === 0 ? "(Всі пацієнти)" : `(Всі пацієнти · ${protoMeta.name})`;
            }
        }

        const { targetNorm, validNorm } = this.syncNormInputForProtocol(proto);

        const status = this.stateManager.get('sessionsStatus');
        const showProtoStrip = status === 'ready' && allSessionsData.length > 0 && patientScoped.length > 0;
        this.syncProtocolSwitchButtons(protoCounts, showProtoStrip);

        const view = status === 'loading' ? 'loading' : status === 'error' ? 'error'
            : allSessionsData.length === 0 ? 'empty' : filtered.length === 0 ? 'noResults' : 'populated';
        const states = { loading: 'doctorLoadingState', empty: 'doctorEmptyState', noResults: 'doctorNoResultsState', error: 'doctorErrorState' };
        Object.entries(states).forEach(([key, id]) => { document.getElementById(id).hidden = view !== key; });
        document.getElementById("tabDoctor").setAttribute("aria-busy", String(view === 'loading'));

        if (this.doctorSearchQuery && patientScoped.length === 0) {
            document.getElementById("doctorNoResultsText").textContent = `За запитом «${this.doctorSearchQuery}» нічого не знайдено`;
        } else if (patientScoped.length > 0 && filtered.length === 0) {
            const who = this.selectedDoctorPatient !== "ALL" ? `пацієнта «${this.selectedDoctorPatient}»` : "обраної вибірки";
            document.getElementById("doctorNoResultsText").textContent = `Для ${who} немає сесій у протоколі «${protoMeta.name}»`;
        } else {
            document.getElementById("doctorNoResultsText").textContent = `Для пацієнта «${this.selectedDoctorPatient}» немає сесій`;
        }

        document.getElementById("btnDownloadCSV").disabled = status !== 'ready' || allSessionsData.length === 0;
        const hasPatientData = status === 'ready' && this.selectedDoctorPatient !== "ALL" && patientScoped.length > 0;
        const showSummary = view === 'populated' && this.selectedDoctorPatient !== "ALL";
        summaryBox.hidden = !showSummary;
        if (quadrantWidget && !showSummary) quadrantWidget.hidden = true;
        document.getElementById("btnDownloadClientCSV").disabled = !hasPatientData;
        document.getElementById("btnDeletePatient").disabled = !hasPatientData;

        if (view !== 'populated') {
            this.renderDoctorSessions([]);
            return;
        }

        if (showSummary) {
            const chrono = filtered.slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
            const first = chrono[0];
            const latest = chrono[chrono.length - 1];

            const patientTitle = this.selectedDoctorPatient !== "ALL" ? this.selectedDoctorPatient : (latest.patientId || "Пацієнт");
            document.getElementById("summaryPatientName").textContent = patientTitle;
            document.getElementById("summaryStartDate").textContent = first.dateStr || "1-ша сесія";
            document.getElementById("summaryCurrentDate").textContent = latest.dateStr || "Поточна";

            const avgSmooth = Math.round(filtered.reduce((sum, s) => sum + (Number(s.smoothness) || 0), 0) / filtered.length);
            const totalDurationSec = Math.round(filtered.reduce((sum, s) => sum + (Number(s.sessionDuration) || 0), 0));
            const badge = document.getElementById("summaryProgressBadge");
            const recElem = document.getElementById("recoveryIndexVal");

            const title1 = document.getElementById("summaryTitle1");
            const title2 = document.getElementById("summaryTitle2");
            const title3 = document.getElementById("summaryTitle3");
            const title4 = document.getElementById("summaryTitle4");
            const sub3 = document.getElementById("summarySub3");
            const sub4 = document.getElementById("summarySub4");

            document.getElementById("summaryTotalSessions").textContent = `${filtered.length}`;

            if (proto === 1) {
                if (title1) title1.textContent = "Старт курсу (Sway RMS)";
                if (title2) title2.textContent = "Поточний Sway RMS";
                if (title3) title3.textContent = "Утримання центру (≤5°)";
                if (title4) title4.textContent = "Сесій / Загальний час";
                if (sub3) sub3.textContent = `Сер. плавність: ${avgSmooth}%`;
                if (sub4) sub4.textContent = "Статична стабілізація";

                const firstSway = Number(first.swayRms) || 0;
                const latestSway = Number(latest.swayRms) || 0;
                const latestStab = Number(latest.stabilityPct) || 0;
                document.getElementById("summaryStartAmp").textContent = `${firstSway.toFixed(1)}°`;
                document.getElementById("summaryCurrentAmp").textContent = `${latestSway.toFixed(1)}°`;
                document.getElementById("summaryAvgSmooth").textContent = `${Math.round(latestStab)}%`;
                document.getElementById("summaryTotalFlexions").textContent = `${totalDurationSec} с`;

                const diffSway = latestSway - firstSway;
                const pctSway = firstSway > 0 ? Math.round((diffSway / firstSway) * 100) : null;
                if (filtered.length === 1) {
                    badge.className = "progress-badge neutral";
                    badge.textContent = "Початкова сесія — базове значення";
                } else if (Math.abs(diffSway) < 1e-6) {
                    badge.className = "progress-badge neutral";
                    badge.textContent = "Без змін Sway RMS: 0.0°";
                    badge.textContent += pctSway === null ? " (відсоток не визначено: база 0°)" : " (0%)";
                } else if (diffSway < 0) {
                    badge.className = "progress-badge";
                    badge.textContent = `Зменшення коливань: ${diffSway.toFixed(1)}°`;
                    badge.textContent += pctSway === null ? " (база 0°)" : ` (${pctSway}%)`;
                } else {
                    badge.className = "progress-badge negative";
                    badge.textContent = `Ріст коливань: +${diffSway.toFixed(1)}°`;
                    badge.textContent += pctSway === null ? " (база 0°)" : ` (+${pctSway}%)`;
                }

                if (recElem) {
                    recElem.textContent = validNorm ? `${Math.round((latestStab / targetNorm) * 100)}%` : "—";
                }
                this.updateBalanceQuadrantWidget(chrono, latest);
            } else if (proto === 2) {
                if (title1) title1.textContent = "Старт курсу (2D Розмах)";
                if (title2) title2.textContent = "Поточний 2D Розмах";
                if (title3) title3.textContent = "Симетрія 4 квадрантів";
                if (title4) title4.textContent = "Сесій / Загальний час";
                if (sub3) sub3.textContent = `Сер. плавність: ${avgSmooth}%`;
                if (sub4) sub4.textContent = "Динамічний баланс";

                const firstSpan = Number(first.amplitude) || 0;
                const latestSpan = Number(latest.amplitude) || 0;
                const latestSym = this.computeSymmetryPct(latest);
                document.getElementById("summaryStartAmp").textContent = `${firstSpan.toFixed(1)}°`;
                document.getElementById("summaryCurrentAmp").textContent = `${latestSpan.toFixed(1)}°`;
                document.getElementById("summaryAvgSmooth").textContent = `${Math.round(latestSym)}%`;
                document.getElementById("summaryTotalFlexions").textContent = `${totalDurationSec} с`;

                const diffSpan = latestSpan - firstSpan;
                const pctSpan = firstSpan > 0 ? Math.round((diffSpan / firstSpan) * 100) : null;
                if (filtered.length === 1) {
                    badge.className = "progress-badge neutral";
                    badge.textContent = "Початкова сесія — базове значення";
                } else if (Math.abs(diffSpan) < 1e-6) {
                    badge.className = "progress-badge neutral";
                    badge.textContent = "Без змін 2D розмаху: 0.0°";
                    badge.textContent += pctSpan === null ? " (відсоток не визначено: база 0°)" : " (0%)";
                } else if (diffSpan > 0) {
                    badge.className = "progress-badge";
                    badge.textContent = `Зміна 2D розмаху: +${diffSpan.toFixed(1)}°`;
                    badge.textContent += pctSpan === null ? " (база 0°)" : ` (+${pctSpan}%)`;
                } else {
                    badge.className = "progress-badge negative";
                    badge.textContent = `Зміна 2D розмаху: ${diffSpan.toFixed(1)}°`;
                    badge.textContent += pctSpan === null ? " (база 0°)" : ` (${pctSpan}%)`;
                }

                if (recElem) {
                    recElem.textContent = validNorm ? `${Math.round((latestSpan / targetNorm) * 100)}%` : "—";
                }
                this.updateBalanceQuadrantWidget(chrono, latest);
            } else {
                if (title1) title1.textContent = "Старт курсу (1-ша сесія)";
                if (title2) title2.textContent = "Поточний результат (Амплітуда)";
                if (title3) title3.textContent = "Сер. індекс плавності";
                if (title4) title4.textContent = "Всього сесій / згинань";
                if (sub3) sub3.textContent = "Контроль тремору";
                if (sub4) sub4.textContent = "Загальний обсяг навантаження";
                if (quadrantWidget) quadrantWidget.hidden = true;

                document.getElementById("summaryStartAmp").textContent = `${(first.amplitude || 0).toFixed(1)}°`;
                document.getElementById("summaryCurrentAmp").textContent = `${(latest.amplitude || 0).toFixed(1)}°`;

                const diffAmp = (latest.amplitude || 0) - (first.amplitude || 0);
                const percent = first.amplitude > 0 ? Math.round((diffAmp / first.amplitude) * 100) : null;

                if (filtered.length === 1) {
                    badge.className = "progress-badge neutral";
                    badge.textContent = "Початкова сесія — базове значення";
                } else if (diffAmp === 0) {
                    badge.className = "progress-badge neutral";
                    badge.textContent = "Без змін: 0.0°";
                } else if (diffAmp > 0) {
                    badge.className = "progress-badge";
                    badge.textContent = `Зміна амплітуди: +${diffAmp.toFixed(1)}°`;
                } else {
                    badge.className = "progress-badge negative";
                    badge.textContent = `Зміна амплітуди: ${diffAmp.toFixed(1)}°`;
                }
                if (filtered.length > 1) {
                    badge.textContent += percent === null ? " (відсоток не визначено: база 0°)"
                        : ` (${percent > 0 ? "+" : ""}${percent}%)`;
                }

                document.getElementById("summaryAvgSmooth").textContent = `${avgSmooth}%`;
                const totalFlex = filtered.reduce((sum, s) => sum + (s.flexionsCount || 0), 0);
                document.getElementById("summaryTotalFlexions").textContent = `${totalFlex}`;

                if (recElem) {
                    recElem.textContent = validNorm ? `${Math.round(((latest.amplitude || 0) / targetNorm) * 100)}%` : "—";
                }
            }
        }

        this.renderDoctorSessions(filtered);
    }

    updateTableHeaders(proto) {
        const headersByProto = {
            0: ["Пацієнт", "Дата і Час", "Мін / Макс Кут", "Амплітуда", "Сер. Швидкість", "Плавність", "Згинання", "Дія"],
            1: ["Пацієнт", "Дата і Час", "Sway RMS (ML/AP)", "Стабільність ≤5°", "Зміщення CoB (R/P)", "Плавність", "Тривалість", "Дія"],
            2: ["Пацієнт", "Дата і Час", "Діапазон ML / AP", "2D Розмах", "Симетрія 4-Кв", "Плавність", "Тривалість", "Дія"]
        };
        const labels = headersByProto[proto] || headersByProto[0];
        labels.forEach((text, idx) => {
            const th = document.getElementById(`thCol${idx + 1}`);
            if (th) th.textContent = text;
        });
    }

    renderDoctorSessions(sessions) {
        const proto = this.selectedDoctorProtocol;
        this.updateTableHeaders(proto);

        const tbody = document.getElementById("sessionsTableBody");
        const chartWrap = document.querySelector(".chart-wrapper");
        if (!tbody) return;
        tbody.innerHTML = "";

        if (sessions.length === 0) {
            this.updateChartData([]);
            if (chartWrap) chartWrap.style.display = "none";
            return;
        }

        if (chartWrap) chartWrap.style.display = "block";

        const fragment = document.createDocumentFragment();

        sessions.slice().reverse().forEach(rec => {
            const tr = document.createElement("tr");

            const tdName = document.createElement("td");
            tdName.className = "session-patient";
            tdName.dataset.label = "Пацієнт";
            tdName.style.cssText = "font-weight:700; color:var(--accent-primary); cursor:pointer; text-decoration: underline; text-underline-offset: 3px;";
            tdName.textContent = rec.patientId || "Пацієнт";
            tdName.onclick = () => this.selectPatientByPill(tdName.textContent, true);

            const tdDate = document.createElement("td");
            tdDate.dataset.label = "Дата і час";
            tdDate.textContent = rec.dateStr || "—";

            const tdCol3 = document.createElement("td");
            const tdCol4 = document.createElement("td");
            tdCol4.style.cssText = "color:#00f2fe; font-weight:700;";
            const tdCol5 = document.createElement("td");
            const tdSmooth = document.createElement("td");
            tdSmooth.dataset.label = "Плавність";
            tdSmooth.style.cssText = "color:#00e676; font-weight:700;";
            tdSmooth.textContent = `${(Number(rec.smoothness) || 0).toFixed(0)}%`;
            const tdCol7 = document.createElement("td");

            if (proto === 1) {
                const sway = Number(rec.swayRms) || 0;
                const ml = Number(rec.mlRms) || 0;
                const ap = Number(rec.apRms) || 0;
                const stab = Number(rec.stabilityPct) || 0;
                const mRoll = Number(rec.meanRoll) || 0;
                const mPitch = Number(rec.meanPitch) || 0;
                const dur = Number(rec.sessionDuration) || 0;

                tdCol3.textContent = `${sway.toFixed(1)}° (${ml.toFixed(1)}°/${ap.toFixed(1)}°)`;
                tdCol4.textContent = `${stab.toFixed(0)}%`;
                tdCol5.textContent = `${mRoll > 0 ? "+" : ""}${mRoll.toFixed(1)}° / ${mPitch > 0 ? "+" : ""}${mPitch.toFixed(1)}°`;
                tdCol7.textContent = `${dur.toFixed(1)} с`;
            } else if (proto === 2) {
                const mlSpan = Math.max(0, (Number(rec.maxAngle) || 0) - (Number(rec.minAngle) || 0));
                const apSpan = Math.max(0, (Number(rec.maxPitch) || 0) - (Number(rec.minPitch) || 0));
                const span2d = Number(rec.amplitude) || 0;
                const sym = this.computeSymmetryPct(rec);
                const dur = Number(rec.sessionDuration) || 0;

                tdCol3.textContent = `${mlSpan.toFixed(1)}° / ${apSpan.toFixed(1)}°`;
                tdCol4.textContent = `${span2d.toFixed(1)}°`;
                tdCol5.textContent = `${sym.toFixed(0)}%`;
                tdCol7.textContent = `${dur.toFixed(1)} с`;
            } else {
                const minSpan = document.createElement("span");
                minSpan.style.cssText = "color:#cbd5e1; font-weight:600;";
                minSpan.textContent = `${(rec.minAngle || 0).toFixed(1)}°`;
                const dotsSpan = document.createElement("span");
                dotsSpan.style.color = "#64748b";
                dotsSpan.textContent = " .. ";
                const maxSpan = document.createElement("span");
                maxSpan.style.cssText = "color:#00e676; font-weight:600;";
                maxSpan.textContent = `${(rec.maxAngle || 0).toFixed(1)}°`;
                const wrapSpan = document.createElement("span");
                wrapSpan.append(minSpan, dotsSpan, maxSpan);

                tdCol3.dataset.label = "Мін / Макс";
                tdCol3.appendChild(wrapSpan);
                tdCol4.dataset.label = "Амплітуда";
                tdCol4.textContent = `${(rec.amplitude || 0).toFixed(1)}°`;
                tdCol5.dataset.label = "Сер. швидкість";
                tdCol5.textContent = `${(rec.avgSpeed || 0).toFixed(1)}°/с`;
                tdCol7.dataset.label = "Згинання";
                tdCol7.textContent = rec.flexionsCount || 0;
            }

            const tdActions = document.createElement("td");
            tdActions.className = "session-actions";
            tdActions.dataset.label = "Дія";
            tdActions.style.textAlign = "center";
            const btnDel = document.createElement("button");
            btnDel.className = "btn btn-delete-session";
            btnDel.setAttribute("aria-label", "Видалити сесію");
            btnDel.title = "Видалити сесію";
            btnDel.textContent = "🗑️";
            btnDel.onclick = () => {
                if (confirm("Видалити запис?")) {
                    this.networkService.sendCommand("deleteSession", { id: rec.id });
                    setTimeout(() => this.networkService.fetchAllSessionsPaginated(), 800);
                }
            };
            tdActions.appendChild(btnDel);

            tr.append(tdName, tdDate, tdCol3, tdCol4, tdCol5, tdSmooth, tdCol7, tdActions);
            fragment.appendChild(tr);
        });

        tbody.appendChild(fragment);
        this.updateChartData(sessions);
    }

    initChart() {
        const ctx = document.getElementById("doctorChartCanvas");
        if (!ctx || typeof Chart === "undefined") return;

        const backgroundZonesPlugin = {
            id: 'backgroundZones',
            beforeDraw: (chart) => {
                const { ctx, chartArea, scales: { x, y } } = chart;
                if (!chartArea) return;
                const zones = chart.$zoneConfig || { redX: 40, redY: 50, greenX: 60, greenY: 80 };

                ctx.save();

                const xRedStart = x.getPixelForValue(0);
                const xRedEnd = x.getPixelForValue(zones.redX);
                const yRedStart = y.getPixelForValue(zones.redY);
                const yRedEnd = y.getPixelForValue(0);

                ctx.fillStyle = 'rgba(255, 23, 68, 0.05)';
                ctx.fillRect(xRedStart, yRedStart, xRedEnd - xRedStart, yRedEnd - yRedStart);

                const xGreenStart = x.getPixelForValue(zones.greenX);
                const xGreenEnd = x.getPixelForValue(100);
                const yGreenStart = y.getPixelForValue(y.max);
                const yGreenEnd = y.getPixelForValue(zones.greenY);

                ctx.fillStyle = 'rgba(0, 230, 118, 0.05)';
                ctx.fillRect(xGreenStart, yGreenStart, xGreenEnd - xGreenStart, yGreenEnd - yGreenStart);

                ctx.restore();
            }
        };

        this.doctorChart = new Chart(ctx, {
            type: "bubble",
            data: {
                datasets: [{
                    label: "Сесії (Матриця відновлення)",
                    data: [],
                    backgroundColor: [],
                    borderColor: [],
                    borderWidth: 1.5
                }]
            },
            plugins: [backgroundZonesPlugin],
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: (context) => {
                                const data = context.raw || {};
                                if (data.protocol === 1) {
                                    return [
                                        `Стабільність ≤5°: ${(data.y || 0).toFixed(1)}%`,
                                        `Плавність: ${(data.x || 0).toFixed(1)}%`,
                                        `Sway RMS: ${(data.swayRms || 0).toFixed(1)}°`,
                                        `Тривалість: ${(data.duration || 0).toFixed(1)} с`
                                    ];
                                }
                                if (data.protocol === 2) {
                                    return [
                                        `2D Розмах: ${(data.y || 0).toFixed(1)}°`,
                                        `Симетрія 4-Кв: ${(data.x || 0).toFixed(1)}%`,
                                        `Плавність: ${(data.smoothness || 0).toFixed(1)}%`,
                                        `Тривалість: ${(data.duration || 0).toFixed(1)} с`
                                    ];
                                }
                                return [
                                    `Амплітуда: ${(data.y || 0).toFixed(1)}°`,
                                    `Плавність: ${(data.x || 0).toFixed(1)}%`,
                                    `Згинання: ${data.flexions || 0} шт.`
                                ];
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        type: 'linear',
                        min: 0,
                        max: 100,
                        title: { display: true, text: 'Плавність / Smoothness (%)', color: '#94a3b8' },
                        grid: { color: "rgba(255, 255, 255, 0.06)" },
                        ticks: { color: "#94a3b8" }
                    },
                    y: {
                        type: 'linear',
                        min: 0,
                        max: 180,
                        title: { display: true, text: 'Амплітуда / Amplitude (°)', color: '#94a3b8' },
                        grid: { color: "rgba(255, 255, 255, 0.06)" },
                        ticks: { color: "#94a3b8" }
                    }
                }
            }
        });
    }

    updateChartData(sessions) {
        if (!this.doctorChart || typeof Chart === "undefined") return;

        const proto = this.selectedDoctorProtocol;
        const bubbleData = [];
        const bgColors = [];
        const borderColors = [];
        let maxYVal = 0;

        if (proto === 1) {
            this.doctorChart.$zoneConfig = { redX: 40, redY: 45, greenX: 65, greenY: 75 };
            this.doctorChart.options.scales.x.title.text = "Плавність / Smoothness (%)";
            this.doctorChart.options.scales.y.title.text = "Утримання центру ≤5° / Stability (%)";
        } else if (proto === 2) {
            this.doctorChart.$zoneConfig = { redX: 40, redY: 10, greenX: 65, greenY: 20 };
            this.doctorChart.options.scales.x.title.text = "Симетрія 4 квадрантів / Symmetry (%)";
            this.doctorChart.options.scales.y.title.text = "2D Розмах нахилу / Tilt Span (°)";
        } else {
            this.doctorChart.$zoneConfig = { redX: 40, redY: 50, greenX: 60, greenY: 80 };
            this.doctorChart.options.scales.x.title.text = "Плавність / Smoothness (%)";
            this.doctorChart.options.scales.y.title.text = "Амплітуда / Amplitude (°)";
        }

        sessions.forEach(s => {
            if (proto === 1) {
                const stab = s.stabilityPct ?? 0;
                const smooth = s.smoothness ?? 0;
                if (!Number.isFinite(stab) || !Number.isFinite(smooth) || stab < 0 || smooth < 0) return;
                const dur = Number.isFinite(s.sessionDuration) ? Math.max(0, s.sessionDuration) : 0;
                maxYVal = Math.max(maxYVal, stab);

                let color = "rgba(255, 145, 0, 0.7)";
                let border = "rgba(255, 145, 0, 1)";
                if (stab >= 75 && smooth >= 65) {
                    color = "rgba(0, 230, 118, 0.7)";
                    border = "rgba(0, 230, 118, 1)";
                } else if (stab < 45 || smooth < 40) {
                    color = "rgba(255, 23, 68, 0.7)";
                    border = "rgba(255, 23, 68, 1)";
                }

                const r = Math.min(22, Math.max(6, Math.log(dur + 1) * 4));
                bubbleData.push({
                    x: Math.min(100, smooth),
                    y: Math.min(100, stab),
                    r,
                    protocol: 1,
                    swayRms: Number(s.swayRms) || 0,
                    duration: dur
                });
                bgColors.push(color);
                borderColors.push(border);
            } else if (proto === 2) {
                const span2d = s.amplitude ?? 0;
                const sym = this.computeSymmetryPct(s);
                const smooth = s.smoothness ?? 0;
                if (!Number.isFinite(span2d) || !Number.isFinite(sym) || !Number.isFinite(smooth) || span2d < 0) return;
                const dur = Number.isFinite(s.sessionDuration) ? Math.max(0, s.sessionDuration) : 0;
                maxYVal = Math.max(maxYVal, span2d);

                let color = "rgba(255, 145, 0, 0.7)";
                let border = "rgba(255, 145, 0, 1)";
                if (span2d >= 20 && sym >= 65) {
                    color = "rgba(0, 230, 118, 0.7)";
                    border = "rgba(0, 230, 118, 1)";
                } else if (span2d < 10 || sym < 40) {
                    color = "rgba(255, 23, 68, 0.7)";
                    border = "rgba(255, 23, 68, 1)";
                }

                const r = Math.min(22, Math.max(6, Math.log(dur + 1) * 4));
                bubbleData.push({
                    x: sym,
                    y: span2d,
                    r,
                    protocol: 2,
                    smoothness: smooth,
                    duration: dur
                });
                bgColors.push(color);
                borderColors.push(border);
            } else {
                const amp = s.amplitude ?? 0;
                const smooth = s.smoothness ?? 0;
                if (!Number.isFinite(amp) || !Number.isFinite(smooth) || amp < 0) return;
                const flex = Number.isFinite(s.flexionsCount) ? Math.max(0, s.flexionsCount) : 0;
                maxYVal = Math.max(maxYVal, amp);

                let color = "rgba(255, 145, 0, 0.7)";
                let border = "rgba(255, 145, 0, 1)";
                if (amp >= 80 && smooth >= 60) {
                    color = "rgba(0, 230, 118, 0.7)";
                    border = "rgba(0, 230, 118, 1)";
                } else if (amp < 50 || smooth < 40) {
                    color = "rgba(255, 23, 68, 0.7)";
                    border = "rgba(255, 23, 68, 1)";
                }

                const r = Math.min(25, Math.max(5, Math.log(flex + 1) * 4));
                bubbleData.push({
                    x: smooth,
                    y: amp,
                    r,
                    protocol: 0,
                    flexions: flex
                });
                bgColors.push(color);
                borderColors.push(border);
            }
        });

        this.doctorChart.data.datasets[0].data = bubbleData;
        this.doctorChart.data.datasets[0].backgroundColor = bgColors;
        this.doctorChart.data.datasets[0].borderColor = borderColors;

        if (proto === 1) {
            this.doctorChart.options.scales.y.max = 100;
        } else if (proto === 2) {
            const paddedMax = Math.ceil(maxYVal / 5 * 1.15) * 5;
            this.doctorChart.options.scales.y.max = Math.max(45, Number.isFinite(paddedMax) ? paddedMax : maxYVal);
        } else {
            const paddedMax = Math.ceil(maxYVal / 10 * 1.15) * 10;
            this.doctorChart.options.scales.y.max = Math.max(180, Number.isFinite(paddedMax) ? paddedMax : maxYVal);
        }
        this.doctorChart.update();
    }

    downloadCSV(sessions, filename) {
        if (!sessions || sessions.length === 0) {
            alert("Немає даних для експорту.");
            return;
        }

        const headers = [
            "ПІБ Пацієнта",
            "Дата",
            "Мінімальний кут (°)",
            "Максимальний кут (°)",
            "Амплітуда (°)",
            "Середня швидкість (°/с)",
            "Плавність (%)",
            "Кількість згинань",
            "Тривалість сесії (с)",
            "Протокол",
            "Мін. нахил Pitch (°)",
            "Макс. нахил Pitch (°)",
            "Центр балансу Roll (°)",
            "Центр балансу Pitch (°)",
            "Sway RMS (°)",
            "ML RMS (°)",
            "AP RMS (°)",
            "Стабільність ≤5° (%)",
            "Квадрант ПЛ (%)",
            "Квадрант ПП (%)",
            "Квадрант ЗЛ (%)",
            "Квадрант ЗП (%)",
            "Симетрія квадрантів (%)"
        ];
        const csvRows = [headers.join(",")];

        const fmtOpt = (val, digits = 2) => {
            const num = Number(val);
            return Number.isFinite(num) ? num.toFixed(digits) : "0";
        };

        for (const s of sessions) {
            const safeName = (s.patientId || 'Пацієнт').replace(/"/g, '""');
            const safeDate = (s.dateStr || '').replace(/"/g, '""');
            const mode = this.getSessionMode(s);
            const protoName = (PROTOCOL_META[mode] || PROTOCOL_META[0]).csvName;

            const baseCols = [
                `"${safeName}"`,
                `"${safeDate}"`,
                s.minAngle || 0,
                s.maxAngle || 0,
                s.amplitude || 0,
                s.avgSpeed || 0,
                s.smoothness || 0,
                s.flexionsCount || 0,
                s.sessionDuration || 0,
                `"${protoName}"`
            ];

            const balanceCols = mode === 0
                ? Array(13).fill("")
                : [
                    fmtOpt(s.minPitch, 2),
                    fmtOpt(s.maxPitch, 2),
                    fmtOpt(s.meanRoll, 2),
                    fmtOpt(s.meanPitch, 2),
                    fmtOpt(s.swayRms, 2),
                    fmtOpt(s.mlRms, 2),
                    fmtOpt(s.apRms, 2),
                    fmtOpt(s.stabilityPct, 1),
                    fmtOpt(s.qFL, 1),
                    fmtOpt(s.qFR, 1),
                    fmtOpt(s.qBL, 1),
                    fmtOpt(s.qBR, 1),
                    fmtOpt(this.computeSymmetryPct(s), 1)
                ];

            csvRows.push([...baseCols, ...balanceCols].join(","));
        }

        const blob = new Blob(["\uFEFF" + csvRows.join("\n")], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.setAttribute("download", filename);
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }
}
