// Global WebSocket, Chart, and application state variables
let ws = null;
let doctorChart = null;
let reconnectInterval = null;
let isAuthorized = false;
let currentPatientName = "";
let allSessionsData = [];
let streamedSessionsBuffer = [];
let selectedDoctorPatient = "ALL";
let usePolling = false;
let pollTimer = null;

// Initialize on DOM content loaded
document.addEventListener("DOMContentLoaded", () => {
    initConnection();
    setupTabNavigation();
    setupEventListeners();
    initChart();
});

// Send commands via WebSocket if open, otherwise fallback to HTTP API
function sendCommand(cmd, params) {
    if (!usePolling && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(Object.assign({ cmd: cmd }, params || {})));
    } else {
        let url = `/api/cmd?action=${encodeURIComponent(cmd)}`;
        if (params) {
            for (const [k, v] of Object.entries(params)) {
                url += `&${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
            }
        }
        fetch(url).then(() => {
            // Poll immediately after executing command
            setTimeout(pollOnce, 400);
        }).catch(e => console.error("[HTTP] Command error:", e));
    }
}

// Attempt WebSocket connection with fallback to HTTP polling after 3 seconds
function initConnection() {
    try {
        initWebSocket();
    } catch (e) {
        console.warn("[Connection] WebSocket unavailable, switching to HTTP:", e);
    }

    // If WebSocket fails to open within 3 seconds, activate HTTP polling fallback
    setTimeout(() => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            console.log("[Connection] WebSocket failed to open, activating HTTP polling");
            usePolling = true;
            if (ws) { try { ws.close(); } catch(e) {} ws = null; }
            if (reconnectInterval) { clearInterval(reconnectInterval); reconnectInterval = null; }
            startHttpPolling();
        }
    }, 3000);
}

// HTTP polling fallback for Captive Portal environments and restricted browsers
function startHttpPolling() {
    document.getElementById("statusDot").classList.add("connected");
    document.getElementById("statusText").textContent = "Пристрій підключено";

    // Synchronize client timestamp with ESP32
    const nowUnix = Math.floor(Date.now() / 1000);
    fetch(`/api/cmd?action=syncTime&timestamp=${nowUnix}`).catch(() => {});

    // Load initial sessions list
    fetch("/api/sessions")
        .then(r => r.json())
        .then(data => {
            allSessionsData = data.sessions || [];
            renderPatientPills(allSessionsData);
            updateDoctorDashboardView();
        }).catch(() => {});

    // Periodic status polling (every 2 seconds)
    pollTimer = setInterval(pollOnce, 2000);
}

function pollOnce() {
    fetch("/api/status")
        .then(r => r.json())
        .then(data => {
            document.getElementById("statusDot").classList.add("connected");
            document.getElementById("statusText").textContent = "Пристрій підключено (HTTP)";
            handleServerMessage(data);
            if (data.angle !== undefined) {
                handleServerMessage({ type: "angle", angle: data.angle });
            }
        }).catch(() => {
            document.getElementById("statusDot").classList.remove("connected");
            document.getElementById("statusText").textContent = "Відключено (очікування HTTP...)";
        });
}

// Initialize WebSocket connection and handlers
function initWebSocket() {
    const wsUrl = `ws://${window.location.host || "192.168.4.1"}/ws`;
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log("[WebSocket] Connection established");
        usePolling = false;
        document.getElementById("statusDot").classList.add("connected");
        document.getElementById("statusText").textContent = "Пристрій підключено";
        
        if (reconnectInterval) {
            clearInterval(reconnectInterval);
            reconnectInterval = null;
        }
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }

        sendCommand("syncTime", { timestamp: Math.floor(Date.now() / 1000) });
        sendCommand("getSessions");
    };

    ws.onerror = () => {};

    ws.onclose = () => {
        if (usePolling) return;
        console.log("[WebSocket] Connection closed");
        document.getElementById("statusDot").classList.remove("connected");
        document.getElementById("statusText").textContent = "Відключено (перепідключення...)";
        
        if (!reconnectInterval) {
            reconnectInterval = setInterval(() => {
                initWebSocket();
            }, 3000);
        }
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleServerMessage(data);
        } catch (e) {}
    };
}

// Process incoming telemetry and status messages from ESP32
function handleServerMessage(data) {
    if (data.type === "angle") {
        // Real-time angle update on visual circle (works in guest and active modes)
        const circle = document.getElementById("circleIndicator");
        const valElem = document.getElementById("angleValueElem");
        
        if (circle) {
            circle.style.transform = `rotate(${data.angle}deg)`;
        }
        if (valElem) {
            valElem.textContent = data.angle.toFixed(1);
        }
    } else if (data.type === "status") {
        // Update LittleFS storage usage indicator
        const used = data.usedBytes || 0;
        const total = data.totalBytes || 1;
        const percent = Math.min(100, Math.round((used / total) * 100));
        
        document.getElementById("memoryBar").style.width = `${percent}%`;
        document.getElementById("memoryText").textContent = 
            `${Math.round(used / 1024)} / ${Math.round(total / 1024)} КБ (${100 - percent}% вільно)`;

        // Synchronize authorization state in case of page refresh
        if (data.sessionActive) {
            isAuthorized = true;
            currentPatientName = data.patientId;
            showAuthorizedUI();
        } else if (isAuthorized && !data.sessionActive) {
            isAuthorized = false;
            showGuestUI();
        }
    } else if (data.type === "liveStats") {
        // Update real-time training metrics during active session
        document.getElementById("statMin").textContent = `${data.minAngle.toFixed(1)}°`;
        document.getElementById("statMax").textContent = `${data.maxAngle.toFixed(1)}°`;
        document.getElementById("statAmp").textContent = `${data.amplitude.toFixed(1)}°`;
        document.getElementById("statSpeed").textContent = `${data.avgSpeed.toFixed(1)}°/с`;
        document.getElementById("statSmooth").textContent = `${data.smoothness.toFixed(0)}%`;
        document.getElementById("statFlex").textContent = `${data.flexionsCount}`;
        document.getElementById("statHold").textContent = `${data.holdingTime.toFixed(1)} с`;
    } else if (data.type === "sessionsList") {
        // Store all sessions, render patient pills, and update doctor dashboard
        allSessionsData = data.sessions || [];
        renderPatientPills(allSessionsData);
        updateDoctorDashboardView();
    } else if (data.type === "sessionsStreamStart") {
        // Start receiving chunked session stream (zero-copy streaming)
        streamedSessionsBuffer = [];
    } else if (data.type === "sessionsStreamChunk") {
        // Append chunk of sessions to in-memory buffer
        if (Array.isArray(data.data)) {
            streamedSessionsBuffer.push(...data.data);
        }
    } else if (data.type === "sessionsStreamEnd") {
        // Stream completed: sort chronologically and update dashboard
        allSessionsData = streamedSessionsBuffer.slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        renderPatientPills(allSessionsData);
        updateDoctorDashboardView();
    }
}

// Setup tab navigation and resizing behavior
function setupTabNavigation() {
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
                updateDoctorDashboardView();
                sendCommand("getSessions");
            }
        });
    });

    window.addEventListener("resize", () => {
        if (document.getElementById("tabDoctor")?.classList.contains("active")) {
            updateDoctorDashboardView();
        }
    });
}

// Setup event listeners for UI buttons and inputs
function setupEventListeners() {
    // Start session button
    document.getElementById("btnStartSession").addEventListener("click", () => {
        const input = document.getElementById("patientIdInput");
        const name = input.value.trim();
        if (!name) {
            alert("Будь ласка, введіть ПІБ пацієнта для початку сесії.");
            return;
        }
        sendCommand("startSession", { patientId: name });
        isAuthorized = true;
        currentPatientName = name;
        showAuthorizedUI();
    });

    // Stop session button
    document.getElementById("btnStopSession").addEventListener("click", () => {
        sendCommand("stopSession");
        isAuthorized = false;
        showGuestUI();
        setTimeout(() => sendCommand("getSessions"), 500);
    });

    // Recalibrate sensor on the fly
    document.getElementById("btnRecalibrate").addEventListener("click", () => {
        sendCommand("recalibrate");
        const btn = document.getElementById("btnRecalibrate");
        const originalText = btn.textContent;
        btn.textContent = "Калібрується...";
        setTimeout(() => { btn.textContent = originalText; }, 1200);
    });

    // Download filtered or global CSV dataset
    document.getElementById("btnDownloadCSV")?.addEventListener("click", () => {
        downloadFilteredCSV();
    });

    // Download CSV dataset for currently selected client
    document.getElementById("btnDownloadClientCSV")?.addEventListener("click", () => {
        downloadFilteredCSV();
    });

    // Search input handlers
    const searchInput = document.getElementById("patientSearchInput");
    const exactSearchBtn = document.getElementById("btnExactSearch");
    
    const performExactSearch = () => {
        if (!searchInput) return;
        const query = searchInput.value.trim();
        if (query.length === 0) {
            selectPatientByPill("ALL", true);
        } else {
            updateDoctorDashboardView(query, true);
        }
    };

    if (exactSearchBtn) {
        exactSearchBtn.addEventListener("click", performExactSearch);
    }
    if (searchInput) {
        searchInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") performExactSearch();
        });
    }

    // Delete all records for selected patient with custom confirmation modal
    document.getElementById("btnDeletePatient")?.addEventListener("click", () => {
        if (selectedDoctorPatient === "ALL") return;
        showCustomConfirm(
            "Видалення пацієнта",
            `Ви дійсно хочете безповоротно видалити ВСІ записи пацієнта «${selectedDoctorPatient}» з флеш-пам'яті пристрою?`,
            "Видалити все",
            () => {
                sendCommand("deletePatient", { patientId: selectedDoctorPatient });
                selectPatientByPill("ALL", true);
            }
        );
    });

    // Recalculate recovery index dynamically when target norm changes
    document.getElementById("targetNormInput")?.addEventListener("input", () => {
        updateDoctorDashboardView();
    });
}

// Switch between Guest UI and Authorized Patient UI
function showAuthorizedUI() {
    document.getElementById("authGuestPanel").style.display = "none";
    document.getElementById("authActivePanel").style.display = "flex";
    document.getElementById("activePatientName").textContent = currentPatientName;
    document.getElementById("liveStatsPanel").style.display = "block";
}

function showGuestUI() {
    document.getElementById("authGuestPanel").style.display = "flex";
    document.getElementById("authActivePanel").style.display = "none";
    document.getElementById("liveStatsPanel").style.display = "none";
    document.getElementById("patientIdInput").value = "";
}

// Initialize Chart.js configuration
function initChart() {
    const ctx = document.getElementById("doctorChartCanvas");
    if (!ctx || typeof Chart === "undefined") return;

    doctorChart = new Chart(ctx, {
        type: "bar",
        data: {
            labels: [],
            datasets: [
                {
                    label: "Амплітуда (°)",
                    data: [],
                    backgroundColor: "rgba(0, 242, 254, 0.7)",
                    borderColor: "#00f2fe",
                    borderWidth: 1,
                    borderRadius: 6
                },
                {
                    label: "Плавність (%)",
                    data: [],
                    backgroundColor: "rgba(0, 230, 118, 0.7)",
                    borderColor: "#00e676",
                    borderWidth: 1,
                    borderRadius: 6
                },
                {
                    label: "Згинання (шт)",
                    data: [],
                    backgroundColor: "rgba(255, 145, 0, 0.7)",
                    borderColor: "#ff9100",
                    borderWidth: 1,
                    borderRadius: 6
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    labels: { color: "#94a3b8", font: { family: "Inter", weight: "600" } }
                }
            },
            scales: {
                x: {
                    grid: { color: "rgba(255, 255, 255, 0.06)" },
                    ticks: { color: "#94a3b8" }
                },
                y: {
                    grid: { color: "rgba(255, 255, 255, 0.06)" },
                    ticks: { color: "#94a3b8" }
                }
            }
        }
    });
}

// Render interactive pills for patient selection
function renderPatientPills(sessions) {
    const container = document.getElementById("patientPillsContainer");
    if (!container) return;

    const counts = {};
    sessions.forEach(s => {
        const name = (s.patientId || "Пацієнт").trim();
        counts[name] = (counts[name] || 0) + 1;
    });

    const uniquePatients = Object.keys(counts).sort((a, b) => a.localeCompare(b, "uk"));

    container.innerHTML = "";
    const fragment = document.createDocumentFragment();

    // "All Patients" pill button
    const allBtn = document.createElement("button");
    allBtn.className = `patient-pill ${selectedDoctorPatient === "ALL" ? "active" : ""}`;
    allBtn.setAttribute("data-patient", "ALL");
    allBtn.innerHTML = `🧑 Всі пацієнти (${sessions.length})`;
    allBtn.onclick = () => selectPatientByPill("ALL", true);
    fragment.appendChild(allBtn);

    // Individual patient pill buttons
    uniquePatients.forEach(name => {
        const btn = document.createElement("button");
        btn.className = `patient-pill ${selectedDoctorPatient === name ? "active" : ""}`;
        btn.setAttribute("data-patient", name);
        btn.innerHTML = `👤 ${name} <span style="opacity:0.75;font-size:0.75rem;">(${counts[name]})</span>`;
        btn.onclick = () => selectPatientByPill(name, true);
        fragment.appendChild(btn);
    });

    container.appendChild(fragment);
}

// Select patient when clicking pill or table cell
function selectPatientByPill(patientName, triggerUpdate = true) {
    selectedDoctorPatient = patientName;
    
    document.querySelectorAll(".patient-pill").forEach(btn => {
        if (btn.getAttribute("data-patient") === patientName) {
            btn.classList.add("active");
        } else {
            btn.classList.remove("active");
        }
    });

    const searchInput = document.getElementById("patientSearchInput");
    if (searchInput && triggerUpdate) searchInput.value = "";

    if (triggerUpdate) updateDoctorDashboardView();
}

// Update doctor dashboard view when selecting patient or filtering
function updateDoctorDashboardView(searchQuery = "", isExactSearch = false) {
    const filterLabel = document.getElementById("tableFilterLabel");
    const summaryBox = document.getElementById("patientSummaryContainer");

    let filtered = allSessionsData;
    if (isExactSearch && searchQuery && typeof searchQuery === "string" && searchQuery.length > 0) {
        const query = searchQuery.trim().toLowerCase();
        filtered = allSessionsData.filter(s => (s.patientId || "").trim().toLowerCase() === query);
        if (filtered.length === 0) {
            filtered = allSessionsData.filter(s => (s.patientId || "").trim().toLowerCase().includes(query));
        }

        if (filterLabel) filterLabel.textContent = `(Пошук: «${searchQuery.trim()}» — знайдено: ${filtered.length})`;
        if (filtered.length > 0) {
            selectedDoctorPatient = (filtered[0].patientId || "Пацієнт").trim();
            document.querySelectorAll(".patient-pill").forEach(btn => {
                btn.classList.toggle("active", btn.getAttribute("data-patient") === selectedDoctorPatient);
            });
        }
    } else if (selectedDoctorPatient && selectedDoctorPatient !== "ALL") {
        filtered = allSessionsData.filter(s => (s.patientId || "Пацієнт").trim() === selectedDoctorPatient);
        if (filterLabel) filterLabel.textContent = `(Пацієнт: ${selectedDoctorPatient})`;
    } else {
        if (filterLabel) filterLabel.textContent = "(Всі пацієнти)";
    }

    const normInput = document.getElementById("targetNormInput");
    const targetNorm = normInput ? (parseFloat(normInput.value) || 90.0) : 90.0;

    // Display clinical summary or empty search notification
    if (isExactSearch && searchQuery && filtered.length === 0 && summaryBox) {
        summaryBox.innerHTML = `
            <div style="padding: 1.8rem 1rem; text-align: center; background: rgba(255, 23, 68, 0.08); border: 1px dashed rgba(255, 23, 68, 0.45); border-radius: 14px; margin-bottom: 0.5rem;">
                <div style="font-size: 2.5rem; margin-bottom: 0.6rem;">🔍 📭</div>
                <h3 style="color: #ff1744; font-size: 1.2rem; margin-bottom: 0.4rem; font-weight: 700;">За запитом «${searchQuery.trim()}» нічого не знайдено</h3>
                <p style="color: var(--text-secondary); font-size: 0.88rem; margin-bottom: 1.2rem; max-width: 480px; margin-left: auto; margin-right: auto; line-height: 1.45;">Пацієнтів або збережених сесій з таким іменем в історії немає. Спробуйте ввести коротшу частину імені або перегляньте загальний список.</p>
                <button class="btn btn-secondary" onclick="selectPatientByPill('ALL', true)" style="padding: 0.5rem 1.2rem; font-size: 0.88rem; border-radius: 8px;">🧑 Показати всіх пацієнтів</button>
            </div>
        `;
        summaryBox.style.display = "block";
    } else if ((selectedDoctorPatient !== "ALL" || searchQuery) && filtered.length > 0 && summaryBox) {
        if (!document.getElementById("summaryPatientName")) {
            summaryBox.innerHTML = `
                <div class="summary-header">
                    <h4 style="margin:0; color:var(--accent-primary); font-size:1.05rem;">
                        👤 Клінічна динаміка: <span id="summaryPatientName" style="color:#ffffff; font-weight:700;">—</span>
                    </h4>
                    <span id="summaryProgressBadge" class="progress-badge">🔥 Прогрес: 0°</span>
                </div>
                <div class="summary-grid">
                    <div class="summary-card">
                        <div class="label">1-ша сесія (<span id="summaryStartDate">—</span>)</div>
                        <div class="val" id="summaryStartAmp">0°</div>
                    </div>
                    <div class="summary-card">
                        <div class="label">Поточна (<span id="summaryCurrentDate">—</span>)</div>
                        <div class="val" id="summaryCurrentAmp" style="color:#00f2fe;">0°</div>
                    </div>
                    <div class="summary-card">
                        <div class="label">Середня плавність</div>
                        <div class="val" id="summaryAvgSmooth" style="color:#00e676;">0%</div>
                    </div>
                    <div class="summary-card">
                        <div class="label">Індекс відновлення</div>
                        <div class="val" id="recoveryIndexVal" style="color:#00e676;">0%</div>
                    </div>
                </div>
                <div style="margin-top: 0.8rem; font-size: 0.82rem; color: var(--text-secondary); display: flex; justify-content: space-between; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 0.6rem;">
                    <span>Всього проведено сесій: <strong id="summaryTotalSessions" style="color:#fff;">0</strong></span>
                    <span>Загальна кількість згинань: <strong id="summaryTotalFlexions" style="color:#fff;">0</strong></span>
                </div>
            `;
        }

        const chrono = filtered.slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        const first = chrono[0];
        const latest = chrono[chrono.length - 1];

        const patientTitle = selectedDoctorPatient !== "ALL" ? selectedDoctorPatient : (latest.patientId || "Пацієнт");
        document.getElementById("summaryPatientName").textContent = patientTitle;
        document.getElementById("summaryStartAmp").textContent = `${(first.amplitude || 0).toFixed(1)}°`;
        document.getElementById("summaryStartDate").textContent = first.dateStr || "1-ша сесія";

        document.getElementById("summaryCurrentAmp").textContent = `${(latest.amplitude || 0).toFixed(1)}°`;
        document.getElementById("summaryCurrentDate").textContent = latest.dateStr || "Поточна";

        const diffAmp = (latest.amplitude || 0) - (first.amplitude || 0);
        const percent = (first.amplitude && first.amplitude > 0) ? Math.round((diffAmp / first.amplitude) * 100) : 0;
        
        const badge = document.getElementById("summaryProgressBadge");
        if (diffAmp >= 0) {
            badge.className = "progress-badge";
            badge.textContent = `🔥 Прогрес: +${diffAmp.toFixed(1)}° (+${percent}%)`;
        } else {
            badge.className = "progress-badge negative";
            badge.textContent = `⚠️ Динаміка: ${diffAmp.toFixed(1)}° (${percent}%)`;
        }

        const avgSmooth = Math.round(filtered.reduce((sum, s) => sum + (s.smoothness || 0), 0) / filtered.length);
        document.getElementById("summaryAvgSmooth").textContent = `${avgSmooth}%`;
        document.getElementById("summaryTotalSessions").textContent = `${filtered.length}`;
        const totalFlex = filtered.reduce((sum, s) => sum + (s.flexionsCount || 0), 0);
        document.getElementById("summaryTotalFlexions").textContent = `${totalFlex}`;

        // Compute functional recovery index relative to target norm
        const recoveryIndex = Math.min(100, Math.round(((latest.amplitude || 0) / targetNorm) * 100));
        const recElem = document.getElementById("recoveryIndexVal");
        if (recElem) {
            recElem.textContent = `${recoveryIndex}%`;
            recElem.style.color = recoveryIndex >= 85 ? "#00e676" : (recoveryIndex >= 60 ? "#ff9100" : "#ff1744");
        }

        summaryBox.style.display = "block";
    } else if (summaryBox) {
        summaryBox.style.display = "none";
    }

    renderDoctorSessions(filtered);
}

// Render sessions table and chart using DocumentFragment for maximum performance
function renderDoctorSessions(sessions) {
    const tbody = document.getElementById("sessionsTableBody");
    const chartWrap = document.querySelector(".chart-wrapper");
    if (!tbody) return;
    tbody.innerHTML = "";

    if (sessions.length === 0) {
        tbody.innerHTML = `<tr><td colspan='8' style='text-align:center; padding: 2.5rem 1rem; color: var(--text-secondary); background: rgba(0,0,0,0.15); border-radius: 8px; white-space: normal; word-break: break-word;'>📭 Збережені сесії поки що відсутні для даного вибору.<br><span style='font-size:0.8rem; color: var(--text-muted); display:inline-block; margin-top:0.3rem;'>Проведіть тренування у вкладці пацієнта або змініть параметри пошуку.</span></td></tr>`;
        if (chartWrap) chartWrap.style.display = "none";
        return;
    }

    if (chartWrap) chartWrap.style.display = "block";

    const labels = [];
    const ampData = [];
    const smoothData = [];
    const flexData = [];

    const fragment = document.createDocumentFragment();

    // Render table rows in reverse chronological order (newest first)
    sessions.slice().reverse().forEach(rec => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td style="font-weight:700; color:var(--accent-primary); cursor:pointer; text-decoration: underline; text-underline-offset: 3px;" onclick="selectPatientByPill('${(rec.patientId || "Пацієнт").trim()}', true)" title="Натисніть, щоб обрати всі записи пацієнта">${rec.patientId || "Пацієнт"}</td>
            <td style="white-space: nowrap;">${rec.dateStr || "—"}</td>
            <td style="white-space: nowrap;"><span style="color:#cbd5e1; font-weight:600;">${rec.minAngle?.toFixed(1)}°</span> <span style="color:#64748b;">..</span> <span style="color:#00e676; font-weight:600;">${rec.maxAngle?.toFixed(1)}°</span></td>
            <td style="color:#00f2fe; font-weight:700;">${rec.amplitude?.toFixed(1)}°</td>
            <td>${rec.avgSpeed?.toFixed(1)}°/с</td>
            <td style="color:#00e676; font-weight:700;">${rec.smoothness?.toFixed(0)}%</td>
            <td>${rec.flexionsCount || 0}</td>
            <td style="text-align: center;">
                <button class="btn" style="padding: 0.25rem 0.6rem; font-size: 0.75rem; background: rgba(255,23,68,0.18); border-color: rgba(255,23,68,0.4); color: #ff1744;" onclick="deleteSingleSession('${rec.filename || ""}', '${rec.dateStr || ""}', '${rec.patientId || ""}')" title="Видалити лише цей помилковий запис">
                    🗑️
                </button>
            </td>
        `;
        fragment.appendChild(tr);

        const dateParts = (rec.dateStr || "").split(" ");
        const shortDate = dateParts[0] || "";
        const shortTime = dateParts[1] || "";
        
        if (selectedDoctorPatient === "ALL") {
            labels.push([rec.patientId || "Пацієнт", shortDate]);
        } else {
            labels.push([shortDate || "Сесія", shortTime]);
        }

        ampData.push(rec.amplitude || 0);
        smoothData.push(rec.smoothness || 0);
        flexData.push(rec.flexionsCount || 0);
    });

    tbody.appendChild(fragment);

    // Dynamically expand inner container width (#chartInnerScroll) to prevent bar squishing
    const innerScroll = document.getElementById("chartInnerScroll");
    const chartWrapContainer = document.getElementById("chartWrapperContainer") || chartWrap;
    const baseW = chartWrapContainer ? (chartWrapContainer.clientWidth || 320) : 320;
    const reqW = Math.max(baseW, sessions.length * 58 + 65);

    if (innerScroll) {
        innerScroll.style.width = reqW + "px";
    }

    drawAutonomousChart(sessions, labels, ampData, smoothData, reqW);
}

// Autonomous HTML5 Canvas chart renderer (works offline and in Captive Portal without CDN)
function drawAutonomousChart(sessions, labels, ampData, smoothData, reqW = 320) {
    if (doctorChart && typeof Chart !== "undefined") {
        doctorChart.data.labels = labels;
        doctorChart.data.datasets[0].data = ampData;
        doctorChart.data.datasets[1].data = smoothData;
        doctorChart.data.datasets[2].data = sessions.map(s => s.flexionsCount || 0);
        doctorChart.update();
        return;
    }

    const canvas = document.getElementById("doctorChartCanvas");
    if (!canvas || sessions.length === 0) return;
    
    const wrapper = canvas.parentElement;
    const rect = wrapper ? wrapper.getBoundingClientRect() : canvas.getBoundingClientRect();
    let baseWidth = rect.width || wrapper?.clientWidth || canvas.clientWidth || 320;
    let height = rect.height || wrapper?.clientHeight || canvas.clientHeight || 220;

    if (baseWidth < 50) baseWidth = 320;
    if (height < 50) height = 220;

    const width = Math.max(baseWidth, reqW);
    canvas.style.width = width + "px";
    if (wrapper) {
        wrapper.style.overflowX = "auto";
        wrapper.style.webkitOverflowScrolling = "touch";
    }

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const padTop = 28, padBottom = 46, padLeft = 45, padRight = 15;
    const chartW = width - padLeft - padRight;
    const chartH = height - padTop - padBottom;

    // Grid lines
    ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
    ctx.lineWidth = 1;
    const maxVal = Math.max(200, ...ampData) * 1.15;
    const steps = 4;
    ctx.fillStyle = "#64748b";
    ctx.font = "600 11px Inter, sans-serif";
    ctx.textAlign = "right";

    for (let i = 0; i <= steps; i++) {
        const y = padTop + chartH - (i / steps) * chartH;
        const val = Math.round((i / steps) * maxVal);
        ctx.beginPath();
        ctx.moveTo(padLeft, y);
        ctx.lineTo(width - padRight, y);
        ctx.stroke();
        ctx.fillText(val + "°", padLeft - 8, y + 4);
    }

    // Render amplitude bars
    const n = ampData.length;
    const slotW = chartW / n;
    const barW = Math.min(46, slotW * 0.55);

    for (let i = 0; i < n; i++) {
        const val = ampData[i] || 0;
        const barH = (val / maxVal) * chartH;
        const x = padLeft + i * slotW + (slotW - barW) / 2;
        const y = padTop + chartH - barH;

        const grad = ctx.createLinearGradient(x, y, x, padTop + chartH);
        grad.addColorStop(0, "#00f2fe");
        grad.addColorStop(1, "rgba(0, 242, 254, 0.12)");

        ctx.fillStyle = grad;
        ctx.beginPath();
        if (ctx.roundRect) {
            ctx.roundRect(x, y, barW, barH, [6, 6, 0, 0]);
        } else {
            ctx.rect(x, y, barW, barH);
        }
        ctx.fill();

        ctx.strokeStyle = "#00f2fe";
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.fillStyle = "#ffffff";
        ctx.font = "700 11px Inter, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(val.toFixed(1) + "°", x + barW / 2, y - 6);

        const labelItem = labels[i];
        if (Array.isArray(labelItem)) {
            const line1 = (labelItem[0] || "").substring(0, 10);
            const line2 = (labelItem[1] || "").substring(0, 10);
            
            ctx.fillStyle = "#e2e8f0";
            ctx.font = "700 10.5px Inter, sans-serif";
            ctx.textAlign = "center";
            ctx.fillText(line1, x + barW / 2, padTop + chartH + 16);

            ctx.fillStyle = "#64748b";
            ctx.font = "500 9.5px Inter, sans-serif";
            ctx.fillText(line2, x + barW / 2, padTop + chartH + 31);
        } else {
            const strLabel = String(labelItem || "");
            const shortLabel = strLabel.length > 12 ? strLabel.substring(0, 10) + ".." : strLabel;
            ctx.fillStyle = "#94a3b8";
            ctx.font = "500 10px Inter, sans-serif";
            ctx.textAlign = "center";
            ctx.fillText(shortLabel, x + barW / 2, padTop + chartH + 20);
        }
    }
}

// Delete single session with custom confirmation modal
function deleteSingleSession(filename, dateStr, patientId) {
    if (!filename) return;
    showCustomConfirm(
        "Видалення запису",
        `Ви впевнені, що хочете видалити тренування від ${dateStr} для пацієнта «${patientId || "Пацієнт"}»?`,
        "Видалити",
        () => {
            sendCommand("deleteSession", { filename: filename });
        }
    );
}

// Download filtered or global dataset as CSV with BOM for Excel compatibility
function downloadFilteredCSV() {
    let filtered = allSessionsData;
    let fileName = "Rehab_All_Sessions.csv";

    if (selectedDoctorPatient && selectedDoctorPatient !== "ALL") {
        filtered = allSessionsData.filter(s => (s.patientId || "Пацієнт").trim() === selectedDoctorPatient);
        fileName = `Rehab_Client_${selectedDoctorPatient.replace(/\s+/g, "_")}.csv`;
    }

    if (filtered.length === 0) {
        alert("📭 Немає даних для експорту за поточним вибором.");
        return;
    }

    let csv = "\uFEFFІм'я Пацієнта,Дата і Час,Мінімальний кут (град),Максимальний кут (град),Амплітуда (град),Середня швидкість (град/с),Плавність (%),Кількість згинань,Час утримання (с)\r\n";

    filtered.forEach(rec => {
        const cleanName = (rec.patientId || "Пацієнт").replace(/,/g, " ");
        csv += `${cleanName},${rec.dateStr || ""},${(rec.minAngle || 0).toFixed(2)},${(rec.maxAngle || 0).toFixed(2)},${(rec.amplitude || 0).toFixed(2)},${(rec.avgSpeed || 0).toFixed(2)},${(rec.smoothness || 0).toFixed(2)},${rec.flexionsCount || 0},${(rec.holdingTime || 0).toFixed(2)}\r\n`;
    });

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", fileName);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// Custom confirmation modal implementation (compatible with iOS and Android Captive Portal)
function showCustomConfirm(title, text, okBtnText, onConfirm) {
    const modal = document.getElementById("customConfirmModal");
    if (!modal) {
        if (confirm(`${title}\n\n${text}`)) onConfirm();
        return;
    }
    document.getElementById("customConfirmTitle").textContent = title;
    document.getElementById("customConfirmText").textContent = text;
    const okBtn = document.getElementById("customConfirmOkBtn");
    const cancelBtn = document.getElementById("customConfirmCancelBtn");
    okBtn.textContent = okBtnText || "Підтвердити";

    modal.classList.add("active");

    const cleanup = () => {
        modal.classList.remove("active");
        okBtn.onclick = null;
        cancelBtn.onclick = null;
    };

    cancelBtn.onclick = () => cleanup();
    okBtn.onclick = () => {
        cleanup();
        onConfirm();
    };
}
