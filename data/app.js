// Глобальные переменные WebSocket и графиков
let ws = null;
let doctorChart = null;
let reconnectInterval = null;
let isAuthorized = false;
let currentPatientName = "";

// Инициализация при полной загрузке DOM
document.addEventListener("DOMContentLoaded", () => {
    initWebSocket();
    setupTabNavigation();
    setupEventListeners();
    initChart();
});

// Настройка подключения к WebSocket
function initWebSocket() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log("[WebSocket] Соединение установлено");
        document.getElementById("statusDot").classList.add("connected");
        document.getElementById("statusText").textContent = "Устройство подключено";
        
        if (reconnectInterval) {
            clearInterval(reconnectInterval);
            reconnectInterval = null;
        }

        // Автоматическая незаметная синхронизация времени с устройством врача
        const nowUnix = Math.floor(Date.now() / 1000);
        ws.send(JSON.stringify({ cmd: "syncTime", timestamp: nowUnix }));
        
        // Запрос списка сессий для вкладки врача
        ws.send(JSON.stringify({ cmd: "getSessions" }));
    };

    ws.onclose = () => {
        console.log("[WebSocket] Соединение потеряно");
        document.getElementById("statusDot").classList.remove("connected");
        document.getElementById("statusText").textContent = "Отключено (переподключение...)";
        
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
        } catch (e) {
            console.error("[WebSocket] Ошибка парсинга JSON:", e);
        }
    };
}

// Обработка входящих сообщений от ESP32
function handleServerMessage(data) {
    if (data.type === "angle") {
        // Динамическое отображение угла на круге (работает всегда, даже в гостевом режиме)
        const circle = document.getElementById("circleIndicator");
        const valElem = document.getElementById("angleValueElem");
        
        if (circle) {
            circle.style.transform = `rotate(${data.angle}deg)`;
        }
        if (valElem) {
            valElem.textContent = data.angle.toFixed(1);
        }
    } else if (data.type === "status") {
        // Обновление индикатора свободной памяти LittleFS
        const used = data.usedBytes || 0;
        const total = data.totalBytes || 1;
        const percent = Math.min(100, Math.round((used / total) * 100));
        
        document.getElementById("memoryBar").style.width = `${percent}%`;
        document.getElementById("memoryText").textContent = 
            `${Math.round(used / 1024)} / ${Math.round(total / 1024)} КБ (${100 - percent}% свободно)`;

        // Синхронизация состояния авторизации на случай перезагрузки страницы
        if (data.sessionActive) {
            isAuthorized = true;
            currentPatientName = data.patientId;
            showAuthorizedUI();
        } else if (isAuthorized && !data.sessionActive) {
            isAuthorized = false;
            showGuestUI();
        }
    } else if (data.type === "liveStats") {
        // Обновление живых метрик активной сессии
        document.getElementById("statMin").textContent = `${data.minAngle.toFixed(1)}°`;
        document.getElementById("statMax").textContent = `${data.maxAngle.toFixed(1)}°`;
        document.getElementById("statAmp").textContent = `${data.amplitude.toFixed(1)}°`;
        document.getElementById("statSpeed").textContent = `${data.avgSpeed.toFixed(1)}°/с`;
        document.getElementById("statSmooth").textContent = `${data.smoothness.toFixed(0)}%`;
        document.getElementById("statFlex").textContent = `${data.flexionsCount}`;
        document.getElementById("statHold").textContent = `${data.holdingTime.toFixed(1)} с`;
    } else if (data.type === "sessionsList") {
        // Обновление таблицы и графиков во вкладке врача
        renderDoctorSessions(data.sessions || []);
    }
}

// Переключение вкладок
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

            if (targetId === "tabDoctor" && ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ cmd: "getSessions" }));
            }
        });
    });
}

// Слушатели кнопок
function setupEventListeners() {
    // Начать сессию
    document.getElementById("btnStartSession").addEventListener("click", () => {
        const input = document.getElementById("patientIdInput");
        const name = input.value.trim();
        if (!name) {
            alert("Пожалуйста, введите Имя и Фамилию пациента для начала сессии.");
            return;
        }
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ cmd: "startSession", patientId: name }));
            isAuthorized = true;
            currentPatientName = name;
            showAuthorizedUI();
        }
    });

    // Выйти (остановить сессию)
    document.getElementById("btnStopSession").addEventListener("click", () => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ cmd: "stopSession" }));
            isAuthorized = false;
            showGuestUI();
            ws.send(JSON.stringify({ cmd: "getSessions" }));
        }
    });

    // Рекалибровка датчика на лету
    document.getElementById("btnRecalibrate").addEventListener("click", () => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ cmd: "recalibrate" }));
            const btn = document.getElementById("btnRecalibrate");
            const originalText = btn.textContent;
            btn.textContent = "Калибруется...";
            setTimeout(() => { btn.textContent = originalText; }, 1200);
        }
    });

    // Скачать CSV данные
    document.getElementById("btnDownloadCSV").addEventListener("click", () => {
        window.location.href = "/download.csv";
    });
}

// Переключение интерфейса между Гостем и Авторизованным пациентом
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

// Инициализация Chart.js графика
function initChart() {
    const ctx = document.getElementById("doctorChartCanvas");
    if (!ctx || typeof Chart === "undefined") return;

    doctorChart = new Chart(ctx, {
        type: "bar",
        data: {
            labels: [],
            datasets: [
                {
                    label: "Амплитуда (°)",
                    data: [],
                    backgroundColor: "rgba(0, 242, 254, 0.7)",
                    borderColor: "#00f2fe",
                    borderWidth: 1,
                    borderRadius: 6
                },
                {
                    label: "Плавность (%)",
                    data: [],
                    backgroundColor: "rgba(0, 230, 118, 0.7)",
                    borderColor: "#00e676",
                    borderWidth: 1,
                    borderRadius: 6
                },
                {
                    label: "Сгибания (шт)",
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

// Отрисовка таблицы и графика для врача
function renderDoctorSessions(sessions) {
    const tbody = document.getElementById("sessionsTableBody");
    const chartWrap = document.querySelector(".chart-wrapper");
    if (!tbody) return;
    tbody.innerHTML = "";

    if (sessions.length === 0) {
        // Убираем горизонтальный скролл при пустой таблице и делаем аккуратную заглушку
        tbody.innerHTML = `<tr><td colspan='7' style='text-align:center; padding: 2.5rem 1rem; color: var(--text-secondary); background: rgba(0,0,0,0.15); border-radius: 8px;'>📭 Сохраненные сессии пока отсутствуют.<br><span style='font-size:0.8rem; color: var(--text-muted);'>Проведите тренировку во вкладке пациента и завершите сессию, чтобы данные появились здесь.</span></td></tr>`;
        if (chartWrap) chartWrap.style.display = "none";
        return;
    }

    if (chartWrap) chartWrap.style.display = "block";

    const labels = [];
    const ampData = [];
    const smoothData = [];
    const flexData = [];

    // Заполнение таблицы в обратном порядке (сначала новые)
    sessions.slice().reverse().forEach(rec => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td style="font-weight:700;">${rec.patientId || "Пациент"}</td>
            <td>${rec.dateStr || "—"}</td>
            <td>${rec.minAngle?.toFixed(1)}° / ${rec.maxAngle?.toFixed(1)}°</td>
            <td style="color:#00f2fe; font-weight:700;">${rec.amplitude?.toFixed(1)}°</td>
            <td>${rec.avgSpeed?.toFixed(1)}°/с</td>
            <td style="color:#00e676; font-weight:700;">${rec.smoothness?.toFixed(0)}%</td>
            <td>${rec.flexionsCount || 0}</td>
        `;
        tbody.appendChild(tr);

        // Данные для графика (хронологический порядок)
        labels.push(`${rec.patientId} (${rec.dateStr?.split(" ")[0] || ""})`);
        ampData.push(rec.amplitude);
        smoothData.push(rec.smoothness);
        flexData.push(rec.flexionsCount);
    });

    if (doctorChart) {
        doctorChart.data.labels = labels;
        doctorChart.data.datasets[0].data = ampData;
        doctorChart.data.datasets[1].data = smoothData;
        doctorChart.data.datasets[2].data = flexData;
        doctorChart.update();
    }
}
