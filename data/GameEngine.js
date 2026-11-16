const TWO_DIRECTION = "two-direction";
const FOUR_DIRECTION = "four-direction";

const MODE_INPUT_PROFILES = {
    [TWO_DIRECTION]: { deadzone: 0.08, sensitivityDeg: 30 },
    [FOUR_DIRECTION]: { deadzone: 0.05, sensitivityDeg: 15 }
};

const shortestAngleDelta = (angle, origin) => {
    const delta = Number(angle) - Number(origin);
    if (!Number.isFinite(delta)) return 0;
    return ((delta + 180) % 360 + 360) % 360 - 180;
};

export class GameInput {
    constructor() {
        this.mode = TWO_DIRECTION;
        this.deadzone = 0.08;
        this.sensitivityDeg = 30;
        this.roll = 0;
        this.pitch = 0;
        this.rollTare = 0;
        this.pitchTare = 0;
    }

    setAngles(roll, pitch) {
        if (Number.isFinite(Number(roll))) this.roll = Number(roll);
        if (Number.isFinite(Number(pitch))) this.pitch = Number(pitch);
    }

    configure({ deadzone = this.deadzone, sensitivityDeg = this.sensitivityDeg } = {}) {
        const nextDeadzone = Number(deadzone);
        const nextSensitivity = Number(sensitivityDeg);
        if (Number.isFinite(nextDeadzone)) {
            this.deadzone = Math.max(0, Math.min(0.95, nextDeadzone));
        }
        if (Number.isFinite(nextSensitivity) && nextSensitivity > 0) {
            this.sensitivityDeg = Math.max(1, nextSensitivity);
        }
    }

    tare() {
        if (Number.isFinite(this.roll)) this.rollTare = this.roll;
        if (Number.isFinite(this.pitch)) this.pitchTare = this.pitch;
    }

    resetTare() {
        this.rollTare = 0;
        this.pitchTare = 0;
    }

    normalize(angle, origin = 0) {
        const numAngle = Number(angle);
        const numOrigin = Number(origin);
        if (!Number.isFinite(numAngle) || !Number.isFinite(numOrigin)) return 0;
        const sensitivity = Number.isFinite(this.sensitivityDeg) && this.sensitivityDeg > 0 ? this.sensitivityDeg : 30;
        const deadzone = Number.isFinite(this.deadzone) ? Math.max(0, Math.min(0.95, this.deadzone)) : 0.08;
        const scaled = Math.max(-1, Math.min(1, shortestAngleDelta(numAngle, numOrigin) / sensitivity));
        const magnitude = Math.abs(scaled);
        if (!Number.isFinite(magnitude) || magnitude <= deadzone) return 0;
        const normalized = Math.sign(scaled) * (magnitude - deadzone) / (1 - deadzone);
        return Math.max(-1, Math.min(1, normalized));
    }

    get horizontal() {
        return this.normalize(this.roll, this.rollTare);
    }

    get vertical() {
        return this.mode === FOUR_DIRECTION ? this.normalize(this.pitch, this.pitchTare) : 0;
    }

    getAxis(axis) {
        const name = String(axis || "").toLowerCase();
        if (name === "horizontal" || name === "x") return this.horizontal;
        if (name === "vertical" || name === "y") return this.vertical;
        return 0;
    }
}

export class GameEngine {
    constructor(stateManager) {
        this.stateManager = stateManager;
        window.engineInstance = this;
        window.RehabGames = window.RehabGames || {};
        window.RehabGames.register = (gameId, GameClass, inputRequirements = GameClass.inputRequirements || { directions: 2, inputMode: "2way" }) => {
            const directions = Number(inputRequirements?.directions) >= 4
                || inputRequirements?.inputMode === "4way"
                || inputRequirements?.mode === "4way" ? 4 : 2;
            const normalizedReq = {
                ...inputRequirements,
                directions,
                inputMode: directions >= 4 ? "4way" : "2way"
            };
            GameClass.inputRequirements = normalizedReq;
            window.RehabGames[gameId] = GameClass;
        };
        
        this.currentAngle = 0;
        this.currentPitch = 0;
        this.rawRoll = 0;
        this.rawPitch = 0;
        this.rawRollTare = 0;
        this.rawPitchTare = 0;
        this.invertX = Boolean(this.stateManager.get('invertAxes'));
        this.invertY = Boolean(this.stateManager.get('invertPitch'));
        this.swapAxes = Boolean(this.stateManager.get('swapAxes'));
        this.axisInverted = this.invertX;

        this.activeGame = null;
        this.onAutoTare = null;
        this.input = new GameInput();
        this.userInputMode = this.stateManager.get('gameInputMode') || TWO_DIRECTION;
        this.animationId = null;
        this.lastTime = 0;
        this.lastAngleSampleTime = null;
        this.angleSampleInterval = 1 / 20;
        this.isRunning = false;
        this.loadRequestId = 0;
        this.loadingScripts = new Map();
        this.applyInputMode();
        
        this.api = {
            updateHUD: (key, value) => {
                const el = document.getElementById(key);
                if (el) el.textContent = value;
            },
            updateCalibration: (min, max) => {
                const safeMin = Number(min);
                const safeMax = Number(max);
                if (Number.isFinite(safeMin) && Number.isFinite(safeMax) && safeMax >= safeMin) {
                    this.stateManager.updateMultiple({ calibMin: safeMin, calibMax: safeMax });
                }
            },
            setCustomHTML: (htmlString) => {
                const container = document.getElementById("custom-game-ui");
                if (container) {
                    container.innerHTML = htmlString;
                    container.style.pointerEvents = htmlString.trim() ? "auto" : "none";
                }
            },
            clearCustomHTML: () => {
                const container = document.getElementById("custom-game-ui");
                if (container) {
                    container.innerHTML = '';
                    container.style.pointerEvents = "none";
                }
            }
        };

        this.handleResize = () => {
            if (this.activeGame && this.isRunning) {
                const canvas = document.getElementById("mainGameCanvas");
                if (canvas) {
                    const size = this.resizeCanvas(canvas);
                    if (this.activeGame.resize) this.activeGame.resize(size.width, size.height);
                }
            }
        };
        window.addEventListener('resize', this.handleResize);
    }

    _mapOrientation(rawRoll, rawPitch) {
        const baseX = this.swapAxes ? rawPitch : rawRoll;
        const baseY = this.swapAxes ? rawRoll : rawPitch;
        return {
            roll: (this.invertX ? -baseX : baseX) || 0,
            pitch: (this.invertY ? -baseY : baseY) || 0
        };
    }

    _unmapOrientation(effRoll, effPitch) {
        const uninvX = (this.invertX ? -effRoll : effRoll) || 0;
        const uninvY = (this.invertY ? -effPitch : effPitch) || 0;
        return {
            rawRoll: this.swapAxes ? uninvY : uninvX,
            rawPitch: this.swapAxes ? uninvX : uninvY
        };
    }

    _applyModeSensitivity(mode) {
        const profile = MODE_INPUT_PROFILES[mode] || MODE_INPUT_PROFILES[TWO_DIRECTION];
        this.input.configure(profile);
    }

    resizeCanvas(canvas) {
        const bounds = canvas.parentElement ? canvas.parentElement.getBoundingClientRect() : canvas.getBoundingClientRect();
        const width = Math.max(1, Math.round(bounds.width || canvas.clientWidth || 1));
        const height = Math.max(1, Math.round(bounds.height || canvas.clientHeight || 1));
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        const backingWidth = Math.round(width * pixelRatio);
        const backingHeight = Math.round(height * pixelRatio);

        if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
            canvas.width = backingWidth;
            canvas.height = backingHeight;
        }

        const ctx = canvas.getContext("2d");
        ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
        return { ctx, width, height };
    }

    start() {
        if (this.animationId !== null) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
        window.removeEventListener('resize', this.handleResize);
        window.addEventListener('resize', this.handleResize);
        this.lastTime = performance.now();
        this.loop(this.lastTime);
    }

    stop() {
        this.stopGame();
        if (this.animationId !== null) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
        window.removeEventListener('resize', this.handleResize);
    }

    setRawAngles(rawRoll, rawPitch) {
        const now = performance.now();
        if (this.lastAngleSampleTime !== null) {
            this.angleSampleInterval = Math.min((now - this.lastAngleSampleTime) / 1000, 0.5);
        }
        this.lastAngleSampleTime = now;
        if (Number.isFinite(Number(rawRoll))) this.rawRoll = Number(rawRoll);
        if (Number.isFinite(Number(rawPitch))) this.rawPitch = Number(rawPitch);
        const mapped = this._mapOrientation(this.rawRoll, this.rawPitch);
        this.input.setAngles(mapped.roll, mapped.pitch);
        this.stateManager.updateMultiple({
            targetAngle: this.input.roll,
            targetPitch: this.input.pitch
        });
    }

    setTargetAngle(angle) {
        this.setTargetAngles(angle, this.input.pitch);
    }

    setTargetAngles(roll, pitch) {
        const now = performance.now();
        if (this.lastAngleSampleTime !== null) {
            this.angleSampleInterval = Math.min((now - this.lastAngleSampleTime) / 1000, 0.5);
        }
        this.lastAngleSampleTime = now;
        this.input.setAngles(roll, pitch);
        const unmapped = this._unmapOrientation(this.input.roll, this.input.pitch);
        this.rawRoll = unmapped.rawRoll;
        this.rawPitch = unmapped.rawPitch;
        this.stateManager.updateMultiple({
            targetAngle: this.input.roll,
            targetPitch: this.input.pitch
        });
    }

    setAxisOrientation({ invertX = this.invertX, invertY = this.invertY, swapAxes = this.swapAxes } = {}) {
        const nextInvertX = Boolean(invertX);
        const nextInvertY = Boolean(invertY);
        const nextSwapAxes = Boolean(swapAxes);
        if (nextInvertX === this.invertX && nextInvertY === this.invertY && nextSwapAxes === this.swapAxes) {
            return;
        }
        this.invertX = nextInvertX;
        this.invertY = nextInvertY;
        this.swapAxes = nextSwapAxes;
        this.axisInverted = nextInvertX;

        const mappedCurrent = this._mapOrientation(this.rawRoll, this.rawPitch);
        const mappedTare = this._mapOrientation(this.rawRollTare, this.rawPitchTare);
        this.input.roll = mappedCurrent.roll;
        this.input.pitch = mappedCurrent.pitch;
        this.input.rollTare = mappedTare.roll;
        this.input.pitchTare = mappedTare.pitch;

        this.stateManager.updateMultiple({
            invertAxes: this.invertX,
            invertPitch: this.invertY,
            swapAxes: this.swapAxes,
            targetAngle: this.input.roll,
            targetPitch: this.input.pitch
        });
    }

    setAxisInversion(inverted) {
        const nextInverted = Boolean(inverted);
        this.setAxisOrientation({
            invertX: nextInverted,
            invertY: nextInverted,
            swapAxes: this.swapAxes
        });
    }

    setInputMode(mode) {
        const nextMode = mode === FOUR_DIRECTION ? FOUR_DIRECTION : TWO_DIRECTION;
        this.userInputMode = nextMode;
        if (this.activeGame) {
            this.input.mode = nextMode;
            this._applyModeSensitivity(nextMode);
            this.activeGame.inputMode = nextMode;
            this.stateManager.update('gameInputMode', nextMode);
            const selector = document.getElementById("gameInputMode");
            if (selector) selector.value = nextMode;
        } else {
            this.applyInputMode();
        }
    }

    applyInputMode() {
        const requirements = this.activeGame?.inputRequirements || this.activeGame?.constructor?.inputRequirements || {};
        const isFourWay = Number(requirements.directions) >= 4
            || requirements.inputMode === "4way"
            || requirements.mode === "4way";
        const mode = isFourWay ? FOUR_DIRECTION : this.userInputMode;
        this.input.mode = mode;
        this._applyModeSensitivity(mode);
        if (this.activeGame) {
            this.activeGame.inputMode = mode;
        }
        this.stateManager.update('gameInputMode', mode);
        const selector = document.getElementById("gameInputMode");
        if (selector) selector.value = mode;
    }

    tareInput() {
        this.input.tare();
        const unmappedTare = this._unmapOrientation(this.input.rollTare, this.input.pitchTare);
        this.rawRollTare = unmappedTare.rawRoll;
        this.rawPitchTare = unmappedTare.rawPitch;
    }

    resetTare() {
        this.rawRoll = 0;
        this.rawPitch = 0;
        this.rawRollTare = 0;
        this.rawPitchTare = 0;
        this.currentAngle = 0;
        this.currentPitch = 0;
        this.input.setAngles(0, 0);
        this.input.resetTare();
        this.stateManager.updateMultiple({
            targetAngle: 0,
            targetPitch: 0,
            displayRoll: 0,
            displayPitch: 0
        });
    }

    loadGame(gameId, callback) {
        window.RehabGames = window.RehabGames || {};
        if (window.RehabGames[gameId]) {
            return callback();
        }
        if (this.loadingScripts.has(gameId)) {
            this.loadingScripts.get(gameId).push(callback);
            return;
        }
        const callbacks = [callback];
        this.loadingScripts.set(gameId, callbacks);
        const script = document.createElement('script');
        script.src = `/games/${gameId}/game.js`;
        script.onload = () => {
            const pending = this.loadingScripts.get(gameId) || [];
            this.loadingScripts.delete(gameId);
            pending.forEach(cb => cb());
        };
        script.onerror = () => {
            this.loadingScripts.delete(gameId);
            script.remove();
            const title = document.getElementById("gamePlaceholderTitle");
            if (title) title.textContent = "Помилка завантаження гри";
        };
        document.body.appendChild(script);
    }

    startGame(gameId) {
        const requestId = ++this.loadRequestId;
        this.loadGame(gameId, () => {
            if (requestId !== this.loadRequestId) return;
            const canvas = document.getElementById("mainGameCanvas");
            const GameClass = window.RehabGames?.[gameId];
            if (!canvas || typeof GameClass !== "function") return;
            
            if (this.activeGame && this.activeGame.stop) {
                this.activeGame.stop();
            }
            this.api.clearCustomHTML();
            this.api.updateHUD("hudScore", "");
            this.api.updateHUD("hudBotState", "Стан: Очікування");

            const { ctx, width, height } = this.resizeCanvas(canvas);
            
            GameClass.inputRequirements = GameClass.inputRequirements || { directions: 2, inputMode: "2way" };
            this.activeGame = new GameClass(ctx, this.api);
            this.applyInputMode();
            this.tareInput();
            if (typeof this.onAutoTare === "function") {
                this.onAutoTare(this.input.rollTare, this.input.pitchTare);
            }
            
            const calibMin = this.stateManager.get('calibMin');
            const calibMax = this.stateManager.get('calibMax');
            this.activeGame.init(canvas, {
                calibMin,
                calibMax,
                difficulty: 'auto',
                inputMode: this.input.mode,
                inputRequirements: GameClass.inputRequirements
            });
            if (this.activeGame.resize) {
                this.activeGame.resize(width, height);
            }
            
            const ph = document.getElementById("gamePlaceholder");
            if (ph) ph.style.display = "none";
            const hud = document.getElementById("gameHUD");
            if (hud) hud.style.display = "flex";
            
            if (!this.isRunning) {
                this.isRunning = true;
            }
        });
    }

    stopGame() {
        this.loadRequestId++;
        this.isRunning = false;
        if (this.activeGame && this.activeGame.stop) {
            this.activeGame.stop();
        }
        this.activeGame = null;
        this.applyInputMode();
        this.api.clearCustomHTML();
        this.api.updateHUD("hudScore", "");
        this.api.updateHUD("hudBotState", "Стан: Очікування");

        const canvas = document.getElementById("mainGameCanvas");
        if (canvas) {
            const ctx = canvas.getContext("2d");
            if (ctx) {
                ctx.save();
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.shadowBlur = 0;
                ctx.globalAlpha = 1;
                ctx.setLineDash([]);
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.restore();
            }
        }
        
        const ph = document.getElementById("gamePlaceholder");
        if (ph) ph.style.display = "flex";
        const title = document.getElementById("gamePlaceholderTitle");
        if (title) title.textContent = "Сесія завершена";
        const hud = document.getElementById("gameHUD");
        if (hud) hud.style.display = "none";
        
        const gc = document.getElementById("gameContainer");
        if (gc) gc.style.display = "none";
        this.stateManager.update('currentAppMode', 'monitor');
    }

    loop = (time) => {
        const now = Number.isFinite(time) ? time : performance.now();
        let dt = (now - this.lastTime) / 1000;
        this.lastTime = now;
        if (!Number.isFinite(dt) || dt < 0 || dt > 0.1) dt = 0.016;
        
        const rawTargetAngle = Number(this.stateManager.get('targetAngle'));
        const rawTargetPitch = Number(this.stateManager.get('targetPitch'));
        const targetAngle = Number.isFinite(rawTargetAngle) ? rawTargetAngle : this.input.roll;
        const targetPitch = Number.isFinite(rawTargetPitch) ? rawTargetPitch : this.input.pitch;
        if (!Number.isFinite(this.currentAngle)) this.currentAngle = targetAngle;
        if (!Number.isFinite(this.currentPitch)) this.currentPitch = targetPitch;
        
        // Smooth interpolation only for visual circle / 2D balance board indicator
        const smoothingDuration = Math.max(1 / 15, this.angleSampleInterval);
        const alpha = 1.0 - Math.exp(-dt / smoothingDuration);
        const angleDelta = shortestAngleDelta(targetAngle, this.currentAngle);
        const pitchDelta = shortestAngleDelta(targetPitch, this.currentPitch);
        this.currentAngle = this.currentAngle + angleDelta * alpha;
        this.currentPitch = this.currentPitch + pitchDelta * alpha;
        
        // Render 1D wrist circle indicator
        const circle = document.getElementById("circleIndicator");
        if (circle && !circle.hidden) {
            circle.style.transform = `rotate(${this.currentAngle}deg)`;
        }

        // Render 2D balance board bubble puck when in 4-direction mode
        const balanceBoard = document.getElementById("balanceBoardVisualizer");
        const puck = document.getElementById("balancePuck");
        if (balanceBoard && puck && !balanceBoard.hidden) {
            const maxOffsetPx = Math.max(36, (balanceBoard.clientWidth || 190) * 0.37);
            const fullScaleDeg = 20;
            let normX = this.currentAngle / fullScaleDeg;
            let normY = this.currentPitch / fullScaleDeg;
            const radialMag = Math.hypot(normX, normY);
            if (radialMag > 1) {
                normX /= radialMag;
                normY /= radialMag;
            }
            const offsetX = normX * maxOffsetPx;
            const offsetY = -normY * maxOffsetPx;
            puck.style.transform = `translate(${offsetX.toFixed(1)}px, ${offsetY.toFixed(1)}px)`;
        }
        
        if (this.isRunning && this.activeGame) {
            // Games receive RAW targetAngle & GameInput for instant reaction (no smoothing delay)
            this.activeGame.update(targetAngle, dt, this.input);
            const canvas = document.getElementById("mainGameCanvas");
            if (canvas && this.activeGame) {
                this.activeGame.draw(canvas.getContext("2d"));
            }
            
            const min = Number(this.stateManager.get('calibMin'));
            const max = Number(this.stateManager.get('calibMax'));
            const safeMin = Number.isFinite(min) ? min : -20;
            const safeMax = Number(max);
            const clampedMax = Number.isFinite(safeMax) ? safeMax : 20;
            this.api.updateHUD("hudAmplitude", `Амплітуда: [${safeMin.toFixed(1)}° .. ${clampedMax.toFixed(1)}°]`);
        }
        
        this.animationId = requestAnimationFrame(this.loop);
    }
}
