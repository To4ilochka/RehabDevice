import { StateManager } from './StateManager.js';
import { NetworkService } from './NetworkService.js';
import { UIManager } from './UIManager.js?v=7';
import { GameEngine } from './GameEngine.js';

function initApp() {
    const stateManager = new StateManager();
    const networkService = new NetworkService();
    const uiManager = new UIManager(stateManager, networkService);
    const gameEngine = new GameEngine(stateManager);
    
    // Expose engine instance for UIManager button callbacks
    window.engineInstance = gameEngine;
    
    networkService.onStatusChange((isConnected, isHttpFallback) => {
        stateManager.updateMultiple({ isConnected, isHttpFallback });
    });
    
    networkService.onMessage((data) => {
        if (data.type === "angle") {
            const invertToggle = document.getElementById("invertAngleToggle");
            const angle = invertToggle && invertToggle.checked ? -data.angle : data.angle;
            gameEngine.setTargetAngle(angle);
        } else if (data.type === "status") {
            stateManager.updateMultiple({
                globalSdAvailable: data.sdAvailable !== false,
                currentFirmwareVersion: data.version || stateManager.get('currentFirmwareVersion'),
                memoryUsage: { used: data.usedBytes || 0, total: data.totalBytes || 1 }
            });
            
            if (data.sessionActive) {
                stateManager.updateMultiple({
                    isAuthorized: true,
                    currentPatientName: data.patientId
                });
            } else if (stateManager.get('isAuthorized') && !data.sessionActive) {
                stateManager.update('isAuthorized', false);
            }
        } else if (data.type === "liveStats") {
            stateManager.update('liveStats', data);
        } else if (data.type === "sessionsLoading" || data.type === "sessionsError") {
            stateManager.update('sessionsStatus', data.type === "sessionsLoading" ? 'loading' : 'error');
            uiManager.updateDoctorDashboardView();
        } else if (data.type === "sessionsComplete") {
            stateManager.update('allSessionsData', data.sessions || []);
            stateManager.update('sessionsStatus', 'ready');
            uiManager.renderPatientPills(data.sessions || []);
            uiManager.updateDoctorDashboardView();
        }
    });
    
    uiManager.init();
    networkService.initConnection();
    gameEngine.start();
    
    setupOTA(stateManager);
}

// OTA (Over-The-Air) Update Logic
function setupOTA(stateManager) {
    const GITHUB_REPO = "To4ilochka/RehabDevice";
    let firmwareUrl = "";
    let filesystemUrl = "";

    const btnCheckUpdates = document.getElementById("btnCheckUpdates");
    const btnInstallUpdate = document.getElementById("btnInstallUpdate");
    const updateStatusInfo = document.getElementById("updateStatusInfo");
    const updateProgressContainer = document.getElementById("updateProgressContainer");
    const updateProgressBar = document.getElementById("updateProgressBar");
    const updateStepText = document.getElementById("updateStepText");
    const updatePercentText = document.getElementById("updatePercentText");

    if (btnCheckUpdates) {
        btnCheckUpdates.addEventListener("click", async () => {
            btnCheckUpdates.disabled = true;
            btnCheckUpdates.textContent = "⏳ Перевірка...";
            
            try {
                const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
                if (!response.ok) throw new Error("Не вдалося підключитися до GitHub");
                
                const release = await response.json();
                const tagName = release.tag_name;
                const currentFirmwareVersion = stateManager.get('currentFirmwareVersion');
                
                const fwAsset = release.assets.find(a => a.name === "firmware.bin");
                const fsAsset = release.assets.find(a => a.name === "littlefs.bin" || a.name === "spiffs.bin" || a.name === "fs.bin");
                
                if (fwAsset) {
                    if (tagName === currentFirmwareVersion) {
                        updateStatusInfo.innerHTML = `✅ У вас встановлена актуальна версія: <strong>${tagName}</strong><br><span style="font-size:0.85em;color:var(--text-secondary)">Оновлення не потрібне.</span>`;
                        btnInstallUpdate.style.display = "none";
                    } else {
                        updateStatusInfo.innerHTML = `✅ Знайдено нову версію: <strong>${tagName}</strong> (Поточна: ${currentFirmwareVersion})<br><span style="font-size:0.85em;color:var(--text-secondary)">Доступні файли для оновлення.</span>`;
                        firmwareUrl = fwAsset.browser_download_url;
                        if (fsAsset) filesystemUrl = fsAsset.browser_download_url;
                        btnInstallUpdate.style.display = "inline-block";
                    }
                } else {
                    updateStatusInfo.innerHTML = `✅ Знайдено реліз <strong>${tagName}</strong>, але він не містить файлів прошивки (.bin).`;
                }
            } catch (err) {
                console.error(err);
                updateStatusInfo.innerHTML = `❌ Помилка перевірки оновлень. Переконайтеся, що на телефоні працює мобільний інтернет. (${err.message})`;
            } finally {
                btnCheckUpdates.disabled = false;
                btnCheckUpdates.textContent = "🔄 Перевірити знову";
            }
        });
    }

    if (btnInstallUpdate) {
        btnInstallUpdate.addEventListener("click", async () => {
            if (confirm("Розпочати оновлення? Не вимикайте пристрій та не закривайте сторінку під час процесу.")) {
                btnInstallUpdate.disabled = true;
                btnCheckUpdates.disabled = true;
                updateProgressContainer.style.display = "block";
                
                try {
                    if (filesystemUrl) {
                        await downloadAndFlash(filesystemUrl, "LittleFS (Файлова система)", 0, 50);
                    }
                    if (firmwareUrl) {
                        await downloadAndFlash(firmwareUrl, "Firmware (Основна прошивка)", filesystemUrl ? 50 : 0, filesystemUrl ? 100 : 100);
                    }
                    
                    updateStepText.textContent = "✅ Оновлення успішне! Перезавантаження...";
                    updatePercentText.textContent = "100%";
                    updateProgressBar.style.width = "100%";
                    updateProgressBar.style.background = "#00e676";
                    
                    setTimeout(() => {
                        fetch("/api/cmd?action=reboot").catch(() => {});
                        updateStatusInfo.innerHTML = "Пристрій перезавантажується. Будь ласка, перепідключіться до мережі через хвилину.";
                    }, 2000);
                    
                } catch (err) {
                    console.error(err);
                    updateStepText.textContent = "❌ Помилка оновлення!";
                    updateStatusInfo.innerHTML = `<span style="color:var(--accent-red)">Помилка: ${err.message}</span>`;
                    btnInstallUpdate.disabled = false;
                    btnCheckUpdates.disabled = false;
                }
            }
        });
    }

    async function downloadAndFlash(url, name, startPercent, endPercent) {
        updateStepText.textContent = `1/2 Скачування ${name} з інтернету...`;
        updatePercentText.textContent = `${startPercent}%`;
        updateProgressBar.style.width = `${startPercent}%`;
        
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Не вдалося завантажити ${name}`);
        const blob = await res.blob();
        
        updateStepText.textContent = `2/2 Прошивка ${name} на пристрій...`;
        updatePercentText.textContent = `${startPercent + (endPercent - startPercent)/2}%`;
        updateProgressBar.style.width = `${startPercent + (endPercent - startPercent)/2}%`;
        
        const formData = new FormData();
        formData.append("file", blob, name.includes("Firmware") ? "firmware.bin" : "littlefs.bin");
        
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open("POST", "/update", true);
            
            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable) {
                    const percentComplete = (e.loaded / e.total) * 100;
                    const totalPercent = startPercent + (endPercent - startPercent)/2 + (percentComplete / 100) * ((endPercent - startPercent)/2);
                    updatePercentText.textContent = `${Math.round(totalPercent)}%`;
                    updateProgressBar.style.width = `${totalPercent}%`;
                }
            };
            
            xhr.onload = () => {
                if (xhr.status === 200) {
                    resolve();
                } else {
                    reject(new Error(`Помилка прошивки ${name} (Код: ${xhr.status})`));
                }
            };
            
            xhr.onerror = () => reject(new Error("Втрачено з'єднання з пристроєм під час прошивки"));
            xhr.send(formData);
        });
    }
}

if (document.readyState === 'loading') {
    document.addEventListener("DOMContentLoaded", initApp);
} else {
    initApp();
}
