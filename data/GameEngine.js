const TWO_DIRECTION = "two-direction";
const FOUR_DIRECTION = "four-direction";

const shortestAngleDelta = (angle, origin) => ((angle - origin + 540) % 360) - 180;

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
        this.deadzone = Math.max(0, Math.min(0.95, Number(deadzone) || 0));
        this.sensitivityDeg = Math.max(1, Number(sensitivityDeg) || this.sensitivityDeg);
    }

    tare() {
        this.rollTare = this.roll;
        this.pitchTare = this.pitch;
    }

    normalize(angle, origin) {
        const scaled = Math.max(-1, Math.min(1, shortestAngleDelta(angle, origin) / this.sensitivityDeg));
        const magnitude = Math.abs(scaled);
        if (magnitude <= this.deadzone) return 0;
        return Math.sign(scaled) * (magnitude - this.deadzone) / (1 - this.deadzone);
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
        window.RehabGames = window.RehabGames || {};
        if (typeof window.RehabGames.register !== "function") {
            window.RehabGames.register = (gameId, GameClass, inputRequirements = GameClass.inputRequirements || { directions: 2 }) => {
                GameClass.inputRequirements = inputRequirements;
                window.RehabGames[gameId] = GameClass;
            };
        }
        
        this.currentAngle = 0;
        this.activeGame = null;
        this.input = new GameInput();
        this.userInputMode = this.stateManager.get('gameInputMode') || TWO_DIRECTION;
        this.animationId = null;
        this.lastTime = 0;
        this.lastAngleSampleTime = null;
        this.angleSampleInterval = 1 / 20;
        this.isRunning = false;
        this.applyInputMode();
        
        this.api = {
            updateHUD: (key, value) => {
                const el = document.getElementById(key);
                if (el) el.textContent = value;
            },
            updateCalibration: (min, max) => {
                this.stateManager.updateMultiple({ calibMin: min, calibMax: max });
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

        window.addEventListener('resize', () => {
            if (this.activeGame && this.isRunning) {
                const canvas = document.getElementById("mainGameCanvas");
                if (canvas) {
                    const size = this.resizeCanvas(canvas);
                    if (this.activeGame.resize) this.activeGame.resize(size.width, size.height);
                }
            }
        });
    }

    resizeCanvas(canvas) {
        const bounds = canvas.parentElement.getBoundingClientRect();
        const width = Math.max(1, Math.round(bounds.width));
        const height = Math.max(1, Math.round(bounds.height));
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
        this.lastTime = performance.now();
        this.loop(this.lastTime);
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
        this.stateManager.updateMultiple({ targetAngle: this.input.roll, targetPitch: this.input.pitch });
    }

    setInputMode(mode) {
        this.userInputMode = mode === FOUR_DIRECTION ? FOUR_DIRECTION : TWO_DIRECTION;
        this.applyInputMode();
    }

    applyInputMode() {
        const requirements = this.activeGame?.inputRequirements || this.activeGame?.constructor?.inputRequirements || {};
        const mode = requirements.directions >= 4 ? FOUR_DIRECTION : this.userInputMode;
        this.input.mode = mode;
        this.stateManager.update('gameInputMode', mode);
        const selector = document.getElementById("gameInputMode");
        if (selector) selector.value = mode;
    }

    tareInput() {
        this.input.tare();
    }

    loadGame(gameId, callback) {
        window.RehabGames = window.RehabGames || {};
        if (window.RehabGames[gameId]) {
            return callback();
        }
        const script = document.createElement('script');
        script.src = `/games/${gameId}/game.js`;
        script.onload = callback;
        document.body.appendChild(script);
    }

    startGame(gameId) {
        this.loadGame(gameId, () => {
            const canvas = document.getElementById("mainGameCanvas");
            
            if (this.activeGame && this.activeGame.stop) {
                this.activeGame.stop();
            }
            this.api.clearCustomHTML();

            const { ctx } = this.resizeCanvas(canvas);
            
            const GameClass = window.RehabGames[gameId];
            GameClass.inputRequirements = GameClass.inputRequirements || { directions: 2 };
            this.activeGame = new GameClass(ctx, this.api);
            this.applyInputMode();
            this.input.tare();
            
            const calibMin = this.stateManager.get('calibMin');
            const calibMax = this.stateManager.get('calibMax');
            this.activeGame.init(canvas, {
                calibMin,
                calibMax,
                difficulty: 'auto',
                inputMode: this.input.mode,
                inputRequirements: GameClass.inputRequirements
            });
            
            document.getElementById("gamePlaceholder").style.display = "none";
            document.getElementById("gameHUD").style.display = "flex";
            
            if (!this.isRunning) {
                this.isRunning = true;
            }
        });
    }

    stopGame() {
        this.isRunning = false;
        if (this.activeGame && this.activeGame.stop) {
            this.activeGame.stop();
        }
        this.activeGame = null;
        this.applyInputMode();
        this.api.clearCustomHTML();
        
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
        let dt = (time - this.lastTime) / 1000;
        this.lastTime = time;
        if (dt > 0.1) dt = 0.016;
        
        const targetAngle = this.stateManager.get('targetAngle');
        
        // Smooth interpolation only for visual circle indicator
        const smoothingDuration = Math.max(1 / 15, this.angleSampleInterval);
        const alpha = 1.0 - Math.exp(-dt / smoothingDuration);
        const angleDelta = ((targetAngle - this.currentAngle + 180) % 360 + 360) % 360 - 180;
        this.currentAngle = this.currentAngle + angleDelta * alpha;
        
        // Render UI circle indicator with smoothed angle
        const circle = document.getElementById("circleIndicator");
        if (circle) {
            circle.style.transform = `rotate(${this.currentAngle}deg)`;
        }
        
        if (this.isRunning && this.activeGame) {
            // Games receive RAW targetAngle for instant reaction (no smoothing delay)
            this.activeGame.update(targetAngle, dt, this.input);
            this.activeGame.draw(document.getElementById("mainGameCanvas").getContext("2d"));
            
            const min = this.stateManager.get('calibMin');
            const max = this.stateManager.get('calibMax');
            this.api.updateHUD("hudAmplitude", `Амплітуда: [${min.toFixed(1)}° .. ${max.toFixed(1)}°]`);
        }
        
        this.animationId = requestAnimationFrame(this.loop);
    }
}
