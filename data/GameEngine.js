export class GameEngine {
    constructor(stateManager) {
        this.stateManager = stateManager;
        
        this.currentAngle = 0;
        this.activeGame = null;
        this.animationId = null;
        this.lastTime = 0;
        this.lastAngleSampleTime = null;
        this.angleSampleInterval = 1 / 20;
        this.isRunning = false;
        
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
        const now = performance.now();
        if (this.lastAngleSampleTime !== null) {
            this.angleSampleInterval = Math.min((now - this.lastAngleSampleTime) / 1000, 0.5);
        }
        this.lastAngleSampleTime = now;
        this.stateManager.update('targetAngle', angle);
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
            this.activeGame = new GameClass(ctx, this.api);
            
            const calibMin = this.stateManager.get('calibMin');
            const calibMax = this.stateManager.get('calibMax');
            this.activeGame.init(canvas, { calibMin, calibMax, difficulty: 'auto' });
            
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
            this.activeGame.update(targetAngle, dt);
            this.activeGame.draw(document.getElementById("mainGameCanvas").getContext("2d"));
            
            const min = this.stateManager.get('calibMin');
            const max = this.stateManager.get('calibMax');
            this.api.updateHUD("hudAmplitude", `Амплітуда: [${min.toFixed(1)}° .. ${max.toFixed(1)}°]`);
        }
        
        this.animationId = requestAnimationFrame(this.loop);
    }
}
