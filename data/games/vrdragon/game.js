// ============================================================================
// Політ Дракона (3D) — Повноекранний 3D-політ для реабілітації та баланс-дошки
// RehabDevice IoT | Single-Viewport 3D + 4-Way MPU6050 Control
// ============================================================================

window.RehabGames = window.RehabGames || {};

class VRDragonGame {
    constructor(ctx, api) {
        this.ctx = ctx;
        this.api = api;
        this.width = 1;
        this.height = 1;
        this.active = false;
        this.rafId = null;

        this.calibMin = -20;
        this.calibMax = 20;
        this.difficulty = "auto";
        this.inputMode = "four-direction";

        // Збережено null-поля для сумісності життєвого циклу без VR-трекінгу голови
        this._orientHandler = null;
        this._touchHandler = null;

        // Стан дракона у нормалізованому тунелі польоту [-1 .. +1]
        this.dragonX = 0;
        this.dragonY = 0;
        this.dragonTargetX = 0;
        this.dragonTargetY = 0;
        this.dragonTilt = 0;
        this.dragonPitchAngle = 0;
        this.wingPhase = 0;

        // Параметри 3D-світу
        this.worldZ = 0;
        this.speed = 1.0;
        this.baseSpeed = 80;

        // Об'єкти сцени
        this.mountains = [];
        this.clouds = [];
        this.crystals = [];
        this.obstacles = [];
        this.rings = [];
        this.stars = [];
        this.particles = [];

        // Рахунок та ігровий стан
        this.score = 0;
        this.crystalsCollected = 0;
        this.ringsPassed = 0;
        this.distanceTraveled = 0;
        this.bestScore = 0;
        this.lives = 3;
        this.hitCooldown = 0;
        this.isAlive = true;
        this.respawnTimer = 0;

        // Ефекти
        this.shakeIntensity = 0;
        this.flashAlpha = 0;
        this.flashColor = "";
        this.comboTimer = 0;
        this.combo = 0;

        // Таймери складності та генерації
        this.difficultyTimer = 0;
        this.obstacleTimer = 0;
        this.crystalTimer = 0;
        this.ringTimer = 0;

        // Візуальні фази
        this.rainbowPhase = 0;
        this.sunGlow = 0;
        this._lastScoreHud = "";
        this._lastStateHud = "";
    }

    init(canvas, options) {
        const opts = options || {};
        this.ctx = canvas.getContext("2d");
        const bounds = canvas.getBoundingClientRect();
        this.resize(
            bounds.width || canvas.clientWidth || canvas.width || 1,
            bounds.height || canvas.clientHeight || canvas.height || 1
        );

        const min = Number(opts.calibMin);
        const max = Number(opts.calibMax);
        this.calibMin = Number.isFinite(min) ? min : -20;
        this.calibMax = Number.isFinite(max) ? max : 20;
        if (this.calibMax <= this.calibMin) {
            this.calibMin = -20;
            this.calibMax = 20;
        }

        this.difficulty = opts.difficulty || "auto";
        this.inputMode = opts.inputMode || "four-direction";
        this.active = true;

        this.dragonX = 0;
        this.dragonY = 0;
        this.dragonTargetX = 0;
        this.dragonTargetY = 0;
        this.dragonTilt = 0;
        this.dragonPitchAngle = 0;
        this.wingPhase = 0;

        this.worldZ = 0;
        this.speed = this.difficulty === "hard" ? 1.3 : this.difficulty === "easy" ? 0.85 : 1.0;
        this.score = 0;
        this.crystalsCollected = 0;
        this.ringsPassed = 0;
        this.distanceTraveled = 0;
        this.lives = 3;
        this.hitCooldown = 0;
        this.isAlive = true;
        this.respawnTimer = 0;
        this.shakeIntensity = 0;
        this.flashAlpha = 0;
        this.flashColor = "";
        this.combo = 0;
        this.comboTimer = 0;
        this.difficultyTimer = 0;
        this.obstacleTimer = 1.4;
        this.crystalTimer = 0.7;
        this.ringTimer = 2.4;
        this.particles = [];
        this._lastScoreHud = "";
        this._lastStateHud = "";

        this._cleanupListeners();
        this._initWorld();
        this._updateHUD();
    }

    resize(width, height) {
        const w = Number(width);
        const h = Number(height);
        this.width = Number.isFinite(w) && w > 0 ? Math.max(1, Math.round(w)) : 1;
        this.height = Number.isFinite(h) && h > 0 ? Math.max(1, Math.round(h)) : 1;
    }

    _cleanupListeners() {
        if (this._touchHandler) {
            document.removeEventListener("touchstart", this._touchHandler);
            this._touchHandler = null;
        }
        if (this._orientHandler) {
            window.removeEventListener("deviceorientation", this._orientHandler);
            this._orientHandler = null;
        }
    }

    _tunnelToWorldX(normX) {
        return normX * 0.68;
    }

    _tunnelToWorldY(normY) {
        return 0.34 + normY * 0.26;
    }

    _initWorld() {
        this.stars = [];
        for (let i = 0; i < 60; i++) {
            this.stars.push({
                x: (Math.random() - 0.5) * 5,
                y: Math.random() * 0.5,
                z: 5 + Math.random() * 25,
                size: 0.5 + Math.random() * 1.8,
                twinkle: Math.random() * Math.PI * 2
            });
        }
        this.mountains = [];
        for (let z = 3; z < 35; z += 1.8 + Math.random() * 2) {
            this._spawnMountain(z);
        }
        this.clouds = [];
        for (let z = 3; z < 25; z += 2.2 + Math.random() * 3) {
            this._spawnCloud(z);
        }
        this.obstacles = [];
        this.crystals = [];
        this.rings = [];
    }

    _spawnMountain(z) {
        const side = Math.random() > 0.5 ? 1 : -1;
        this.mountains.push({
            x: side * (1.05 + Math.random() * 1.1),
            z,
            w: 0.5 + Math.random() * 0.8,
            h: 0.4 + Math.random() * 0.6,
            hue: 100 + Math.random() * 60,
            snow: Math.random() > 0.35
        });
    }

    _spawnCloud(z) {
        this.clouds.push({
            x: (Math.random() - 0.5) * 3,
            y: 0.3 + Math.random() * 0.3,
            z,
            w: 0.2 + Math.random() * 0.35,
            h: 0.06 + Math.random() * 0.08,
            op: 0.2 + Math.random() * 0.3
        });
    }

    _spawnObstacle(z) {
        this.obstacles.push({
            x: (Math.random() - 0.5) * 1.5,
            z,
            w: 0.14 + Math.random() * 0.10,
            h: 0.30 + Math.random() * 0.22,
            hit: false
        });
    }

    _spawnCrystal(z) {
        this.crystals.push({
            x: (Math.random() - 0.5) * 1.5,
            y: (Math.random() - 0.5) * 1.3,
            z,
            collected: false,
            phase: Math.random() * Math.PI * 2,
            size: 0.042
        });
    }

    _spawnRing(z) {
        this.rings.push({
            x: (Math.random() - 0.5) * 1.3,
            y: (Math.random() - 0.5) * 1.2,
            z,
            passed: false,
            size: 0.16,
            phase: Math.random() * Math.PI * 2
        });
    }

    _readInput(currentAngle, input) {
        let x = 0;
        let y = 0;
        const safeAngle = Number(currentAngle);
        const hasFiniteAngle = Number.isFinite(safeAngle);

        if (input && typeof input.getAxis === "function") {
            x = input.getAxis("Horizontal");
            y = input.getAxis("Vertical");
            if (x === 0 && hasFiniteAngle && safeAngle !== input.roll && typeof input.normalize === "function") {
                x = input.normalize(safeAngle, input.rollTare);
            }
        } else if (input && (Number.isFinite(Number(input.x)) || Number.isFinite(Number(input.y)))) {
            x = Number.isFinite(Number(input.x)) ? Number(input.x) : 0;
            y = Number.isFinite(Number(input.y)) ? Number(input.y) : 0;
        } else if (input && (Number.isFinite(Number(input.horizontal)) || Number.isFinite(Number(input.vertical)))) {
            x = Number.isFinite(Number(input.horizontal)) ? Number(input.horizontal) : 0;
            y = Number.isFinite(Number(input.vertical)) ? Number(input.vertical) : 0;
        } else if (hasFiniteAngle) {
            const range = this.calibMax - this.calibMin;
            const norm = Number.isFinite(range) && range > 0 ? (safeAngle - this.calibMin) / range : 0.5;
            x = (Math.max(0, Math.min(1, norm)) - 0.5) * 2;
        }

        return {
            x: Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0,
            y: Number.isFinite(y) ? Math.max(-1, Math.min(1, y)) : 0
        };
    }

    update(currentAngle, dt) {
        if (!this.active) return;
        const input = arguments[2];
        if (input?.mode) this.inputMode = input.mode;
        const safeDt = Number(dt);
        const step = Number.isFinite(safeDt) && safeDt >= 0 ? Math.min(0.1, safeDt) : 0;
        const safeAngle = Number(currentAngle);

        if (Number.isFinite(safeAngle)) {
            let boundsChanged = false;
            if (safeAngle > this.calibMax) {
                this.calibMax += (safeAngle - this.calibMax) * 0.05;
                boundsChanged = true;
            }
            if (safeAngle < this.calibMin) {
                this.calibMin -= (this.calibMin - safeAngle) * 0.05;
                boundsChanged = true;
            }
            if (boundsChanged && this.api && typeof this.api.updateCalibration === "function") {
                this.api.updateCalibration(this.calibMin, this.calibMax);
            }
        }

        const axes = this._readInput(safeAngle, input);
        this.dragonTargetX = axes.x;
        this.dragonTargetY = this.inputMode === "two-direction" ? 0 : axes.y;

        if (step === 0) {
            this.dragonX = this.dragonTargetX;
            this.dragonY = this.dragonTargetY;
            this._updateHUD();
            return;
        }

        const prevX = this.dragonX;
        const prevY = this.dragonY;
        const blend = Math.min(1, step * 8.5);
        this.dragonX += (this.dragonTargetX - this.dragonX) * blend;
        this.dragonY += (this.dragonTargetY - this.dragonY) * blend;

        const dX = this.dragonX - prevX;
        const dY = this.dragonY - prevY;
        const targetTilt = Math.max(-32, Math.min(32, dX * 420 + this.dragonTargetX * 14));
        const targetPitchAngle = Math.max(-18, Math.min(18, dY * 260 + this.dragonTargetY * 10));
        this.dragonTilt += (targetTilt - this.dragonTilt) * Math.min(1, step * 6);
        this.dragonPitchAngle += (targetPitchAngle - this.dragonPitchAngle) * Math.min(1, step * 6);

        this.wingPhase += step * 5.2;
        this.rainbowPhase += step * 0.8;
        this.sunGlow += step * 2;

        this.shakeIntensity *= Math.pow(0.02, step);
        if (this.shakeIntensity < 0.3) this.shakeIntensity = 0;
        this.flashAlpha = Math.max(0, this.flashAlpha - step * 4);
        this.hitCooldown = Math.max(0, this.hitCooldown - step);

        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.life -= step / (p.ml || 0.5);
            p.x += p.vx * step;
            p.y += p.vy * step;
            p.vy += (p.g || 0) * step;
            if (p.life <= 0) this.particles.splice(i, 1);
        }

        if (!this.isAlive) {
            this.respawnTimer -= step;
            if (this.respawnTimer <= 0) {
                this.isAlive = true;
                this.hitCooldown = 2;
            }
            this._updateHUD();
            return;
        }

        const moveSpd = this.baseSpeed * this.speed * step;
        this.worldZ += moveSpd * 0.05;
        this.distanceTraveled += moveSpd;
        this.score += step * 10 * this.speed;
        this.bestScore = Math.max(this.bestScore, Math.floor(this.score));

        this.difficultyTimer += step;
        const baseMaxSpeed = this.difficulty === "hard" ? 2.8 : this.difficulty === "easy" ? 1.8 : 2.5;
        const startSpeed = this.difficulty === "hard" ? 1.3 : this.difficulty === "easy" ? 0.85 : 1.0;
        this.speed = Math.min(baseMaxSpeed, startSpeed + this.difficultyTimer * 0.008);

        this.comboTimer -= step;
        if (this.comboTimer <= 0) this.combo = 0;

        this.obstacleTimer -= step;
        this.crystalTimer -= step;
        this.ringTimer -= step;

        if (this.obstacleTimer <= 0) {
            this._spawnObstacle(this.worldZ + 18 + Math.random() * 5);
            this.obstacleTimer = Math.max(1.1, 3.4 - this.difficultyTimer * 0.015) + Math.random() * 1.4;
        }
        if (this.crystalTimer <= 0) {
            const baseX = (Math.random() - 0.5) * 1.4;
            const baseY = this.inputMode === "two-direction" ? 0 : (Math.random() - 0.5) * 1.25;
            const baseZ = this.worldZ + 12 + Math.random() * 6;
            for (let i = 0; i < 3; i++) {
                this.crystals.push({
                    x: Math.max(-0.9, Math.min(0.9, baseX + (i - 1) * 0.14)),
                    y: Math.max(-0.8, Math.min(0.8, baseY)),
                    z: baseZ + i * 1.2,
                    collected: false,
                    phase: Math.random() * Math.PI * 2,
                    size: 0.042
                });
            }
            this.crystalTimer = 2.0 + Math.random() * 1.8;
        }
        if (this.ringTimer <= 0) {
            const ringZ = this.worldZ + 15 + Math.random() * 7;
            this.rings.push({
                x: (Math.random() - 0.5) * 1.3,
                y: this.inputMode === "two-direction" ? 0 : (Math.random() - 0.5) * 1.15,
                z: ringZ,
                passed: false,
                size: 0.16,
                phase: Math.random() * Math.PI * 2
            });
            this.ringTimer = 4.8 + Math.random() * 4.2;
        }

        const maxZ = this.worldZ + 30;
        let lastM = this.mountains.length > 0 ? Math.max(...this.mountains.map(m => m.z)) : 0;
        while (lastM < maxZ) {
            lastM += 1.8 + Math.random() * 2;
            this._spawnMountain(lastM);
        }
        let lastC = this.clouds.length > 0 ? Math.max(...this.clouds.map(c => c.z)) : 0;
        while (lastC < maxZ) {
            lastC += 2.2 + Math.random() * 3;
            this._spawnCloud(lastC);
        }

        this.mountains = this.mountains.filter(m => m.z > this.worldZ - 2);
        this.clouds = this.clouds.filter(c => c.z > this.worldZ - 2);
        this.obstacles = this.obstacles.filter(o => o.z > this.worldZ - 2);
        this.crystals = this.crystals.filter(c => c.z > this.worldZ - 2);
        this.rings = this.rings.filter(r => r.z > this.worldZ - 2);

        const dragonWorldY = this._tunnelToWorldY(this.dragonY);

        // Зіткнення зі скелями у площині дракона rz ~= 1.0
        if (this.hitCooldown <= 0) {
            for (const o of this.obstacles) {
                if (o.hit) continue;
                const rz = o.z - this.worldZ;
                const fliesOver = dragonWorldY > o.h + 0.03;
                if (!fliesOver && rz > 0.55 && rz < 1.45 && Math.abs(this.dragonX - o.x) < o.w + 0.14) {
                    o.hit = true;
                    this.lives--;
                    this.shakeIntensity = 12;
                    this.flashAlpha = 1;
                    this.flashColor = "#ff1744";
                    this.hitCooldown = 2;
                    this.combo = 0;
                    this.score = Math.max(0, this.score - 30);
                    this._burstParticles(this.dragonX, this.dragonY, "#ff6e40", 14);
                    if (this.lives <= 0) {
                        this.isAlive = false;
                        this.respawnTimer = 3;
                        this.lives = 3;
                        this.speed = startSpeed;
                        this.difficultyTimer = Math.max(0, this.difficultyTimer - 15);
                    }
                    break;
                }
            }
        }

        // Збір кристалів у 3D-тунелі
        for (const cr of this.crystals) {
            if (cr.collected) continue;
            const rz = cr.z - this.worldZ;
            const dx = Math.abs(this.dragonX - cr.x);
            const dy = Math.abs(this.dragonY - (cr.y || 0));
            if (rz > 0.35 && rz < 1.75 && dx < 0.28 && dy < 0.38) {
                cr.collected = true;
                this.crystalsCollected++;
                this.combo++;
                this.comboTimer = 3;
                this.score += 25 * Math.max(1, this.combo);
                this.bestScore = Math.max(this.bestScore, Math.floor(this.score));
                this.flashAlpha = 0.28;
                this.flashColor = "#00f2fe";
                this._burstParticles(cr.x, cr.y || 0, "#00f2fe", 9);
            }
        }

        // Проліт крізь золоті кільця
        for (const r of this.rings) {
            if (r.passed) continue;
            const rz = r.z - this.worldZ;
            const dx = Math.abs(this.dragonX - r.x);
            const dy = Math.abs(this.dragonY - (r.y || 0));
            if (rz > 0.45 && rz < 1.65 && dx < r.size + 0.20 && dy < 0.42) {
                r.passed = true;
                this.ringsPassed++;
                this.score += 100;
                this.bestScore = Math.max(this.bestScore, Math.floor(this.score));
                this.combo += 3;
                this.comboTimer = 4;
                this.flashAlpha = 0.36;
                this.flashColor = "#FFD700";
                this._burstParticles(r.x, r.y || 0, "#FFD700", 16);
            }
        }

        if (this.particles.length < 60 && Math.random() < this.speed * 0.22) {
            this.particles.push({
                x: (Math.random() - 0.5) * 2.4,
                y: Math.random() * 0.65,
                z: this.worldZ + 6 + Math.random() * 4,
                vx: 0,
                vy: 0,
                life: 1,
                ml: 0.3,
                size: 0.003,
                color: "rgba(255,255,255,0.28)",
                type: "line"
            });
        }

        this._updateHUD();
    }

    _burstParticles(normX, normY, color, count) {
        for (let i = 0; i < count; i++) {
            const angle = Math.random() * Math.PI * 2;
            const spd = 0.35 + Math.random() * 0.85;
            this.particles.push({
                x: normX,
                y: normY,
                vx: Math.cos(angle) * spd,
                vy: Math.sin(angle) * spd,
                life: 1,
                ml: 0.65,
                size: 0.012 + Math.random() * 0.009,
                color,
                g: -0.35
            });
        }
    }

    _updateHUD() {
        if (!this.api || typeof this.api.updateHUD !== "function") return;
        const comboStr = this.combo > 1 ? ` | Комбо x${this.combo}` : "";
        const scoreText = `Очки: ${Math.floor(this.score)} | Кристали: ${this.crystalsCollected} | Життя: ${this.lives}/3${comboStr}`;
        const stateText = this.isAlive
            ? `Дистанція: ${Math.floor(this.distanceTraveled)} м | Швидкість: x${this.speed.toFixed(1)}`
            : `Зіткнення! Відновлення: ${Math.max(1, Math.ceil(this.respawnTimer))} с`;

        if (scoreText !== this._lastScoreHud) {
            this.api.updateHUD("hudScore", scoreText);
            this._lastScoreHud = scoreText;
        }
        if (stateText !== this._lastStateHud) {
            this.api.updateHUD("hudBotState", stateText);
            this._lastStateHud = stateText;
        }
    }

    draw(ctx) {
        if (!this.active) return;
        const renderCtx = ctx || this.ctx;
        if (!renderCtx) return;
        this.ctx = renderCtx;

        const W = Math.max(2, this.width);
        const H = Math.max(2, this.height);

        renderCtx.save();
        renderCtx.beginPath();
        renderCtx.rect(0, 0, W, H);
        renderCtx.clip();

        this._drawScene(renderCtx, W, H);

        if (this.flashAlpha > 0) {
            renderCtx.globalAlpha = Math.max(0, Math.min(1, this.flashAlpha * 0.16));
            renderCtx.fillStyle = this.flashColor || "#ffffff";
            renderCtx.fillRect(0, 0, W, H);
            renderCtx.globalAlpha = 1;
        }

        if (!this.isAlive) {
            renderCtx.fillStyle = "rgba(10, 0, 0, 0.68)";
            renderCtx.fillRect(0, 0, W, H);
            const titleSize = Math.max(18, Math.min(34, W * 0.055));
            renderCtx.font = `bold ${titleSize}px sans-serif`;
            renderCtx.textAlign = "center";
            renderCtx.fillStyle = "#ff1744";
            renderCtx.fillText("💥 Зіткнення!", W * 0.5, H * 0.44);

            const subSize = Math.max(13, Math.min(20, W * 0.032));
            renderCtx.font = `${subSize}px sans-serif`;
            renderCtx.fillStyle = "#e2e8f0";
            const sec = Math.max(1, Math.ceil(this.respawnTimer));
            renderCtx.fillText(`Відновлення польоту через ${sec} с...`, W * 0.5, H * 0.53);
        }

        renderCtx.restore();
    }

    _drawScene(ctx, vw, vh) {
        const sx = this.shakeIntensity > 0 ? (Math.random() - 0.5) * this.shakeIntensity : 0;
        const sy = this.shakeIntensity > 0 ? (Math.random() - 0.5) * this.shakeIntensity : 0;
        // Легкий паралакс камери за драконом для відчуття глибини без VR
        const cx = -this.dragonX * vw * 0.04 + sx;
        const cy = this.dragonY * vh * 0.025 + sy;

        this._drawSky(ctx, vw, vh, cy);
        this._drawStars(ctx, vw, vh, cx, cy);
        this._drawSun(ctx, vw, vh, cx, cy);
        this._drawGround(ctx, vw, vh, cx, cy);
        this._drawMtns(ctx, vw, vh, cx, cy);
        this._drawClouds(ctx, vw, vh, cx, cy);
        this._drawRings(ctx, vw, vh, cx, cy);
        this._drawObs(ctx, vw, vh, cx, cy);
        this._drawCrystals(ctx, vw, vh, cx, cy);
        this._drawParts(ctx, vw, vh, cx, cy);
        this._drawDragon(ctx, vw, vh, cx, cy);
    }

    _proj(x, y, z, vw, vh, cx, cy) {
        let rz = z - this.worldZ;
        if (!Number.isFinite(rz) || rz <= 0.1) rz = 0.1;
        const s = 0.5 / rz;
        const cameraHeight = 0.68;
        const horizon = vh * 0.36;

        return {
            x: vw / 2 + x * s * vw + cx,
            y: horizon + (cameraHeight - y) * s * vh + cy,
            s
        };
    }

    _drawSky(ctx, vw, vh, cy) {
        const g = ctx.createLinearGradient(0, cy * 0.5, 0, vh);
        g.addColorStop(0, "#0b0d2a");
        g.addColorStop(0.16, "#141852");
        g.addColorStop(0.36, "#1e3a6e");
        g.addColorStop(0.56, "#2d6a9f");
        g.addColorStop(0.76, "#4a9ec4");
        g.addColorStop(0.92, "#7ecce5");
        g.addColorStop(1, "#aee8f5");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, vw, vh);

        ctx.save();
        ctx.globalAlpha = 0.08;
        ctx.globalCompositeOperation = "screen";
        for (let i = 0; i < 2; i++) {
            const ag = ctx.createLinearGradient(0, vh * 0.05, 0, vh * 0.28);
            const hue = 160 + i * 50 + Math.sin(this.rainbowPhase + i * 2) * 30;
            ag.addColorStop(0, `hsla(${hue}, 90%, 65%, 0)`);
            ag.addColorStop(0.5, `hsla(${hue}, 90%, 65%, 0.7)`);
            ag.addColorStop(1, `hsla(${hue}, 90%, 65%, 0)`);
            ctx.fillStyle = ag;
            ctx.beginPath();
            ctx.moveTo(0, vh * 0.08);
            const stepX = Math.max(12, vw / 18);
            for (let x = 0; x <= vw; x += stepX) {
                const y = vh * 0.12 + Math.sin((x / vw) * 5 + this.rainbowPhase * (1 + i * 0.4)) * vh * 0.04;
                ctx.lineTo(x, y + i * vh * 0.04);
            }
            ctx.lineTo(vw, vh * 0.32);
            ctx.lineTo(0, vh * 0.32);
            ctx.closePath();
            ctx.fill();
        }
        ctx.restore();
    }

    _drawStars(ctx, vw, vh, cx, cy) {
        const t = this.wingPhase * 0.5;
        for (const s of this.stars) {
            const p = this._proj(s.x, s.y + 1.2, this.worldZ + s.z, vw, vh, cx, cy);
            if (p.x < 0 || p.x > vw || p.y < 0 || p.y > vh * 0.45) continue;
            const tw = 0.4 + 0.6 * Math.sin(t + s.twinkle);
            ctx.fillStyle = `rgba(255,255,255,${tw * 0.7})`;
            ctx.beginPath();
            ctx.arc(p.x, p.y, Math.max(0.6, s.size * p.s * 3.2), 0, Math.PI * 2);
            ctx.fill();
        }
    }

    _drawSun(ctx, vw, vh, cx, cy) {
        const sunX = vw * 0.74 + cx * 0.3;
        const sunY = vh * 0.15 + cy * 0.2;
        const sunR = Math.max(14, Math.min(vw, vh) * 0.055);

        for (let i = 3; i >= 0; i--) {
            const r = sunR * (1 + i * 0.75);
            const alpha = 0.045 - i * 0.008;
            ctx.fillStyle = `rgba(255, 200, 50, ${alpha})`;
            ctx.beginPath();
            ctx.arc(sunX, sunY, r, 0, Math.PI * 2);
            ctx.fill();
        }

        const sg = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, sunR);
        sg.addColorStop(0, "#fff8e1");
        sg.addColorStop(0.5, "#ffecb3");
        sg.addColorStop(1, "rgba(255, 183, 77, 0.3)");
        ctx.fillStyle = sg;
        ctx.beginPath();
        ctx.arc(sunX, sunY, sunR, 0, Math.PI * 2);
        ctx.fill();
    }

    _drawGround(ctx, vw, vh, cx, cy) {
        const horizonY = Math.max(0, Math.min(vh - 1, vh * 0.36 + cy));
        const g = ctx.createLinearGradient(0, horizonY, 0, vh);
        g.addColorStop(0, "rgba(20, 62, 38, 0.55)");
        g.addColorStop(0.5, "rgba(14, 45, 28, 0.85)");
        g.addColorStop(1, "rgba(8, 25, 15, 0.96)");
        ctx.fillStyle = g;
        ctx.fillRect(0, horizonY, vw, vh - horizonY);

        // Перспективні лінії долини для чіткого відчуття курсу
        ctx.save();
        ctx.strokeStyle = "rgba(126, 204, 229, 0.12)";
        ctx.lineWidth = 1;
        for (let lane = -3; lane <= 3; lane++) {
            const far = this._proj(lane * 0.35, 0, this.worldZ + 22, vw, vh, cx, cy);
            const near = this._proj(lane * 0.35, 0, this.worldZ + 0.6, vw, vh, cx, cy);
            ctx.beginPath();
            ctx.moveTo(far.x, far.y);
            ctx.lineTo(near.x, near.y);
            ctx.stroke();
        }
        ctx.restore();
    }

    _drawMtns(ctx, vw, vh, cx, cy) {
        const sorted = [...this.mountains].sort((a, b) => b.z - a.z);
        for (const m of sorted) {
            const rz = m.z - this.worldZ;
            if (rz < 0.5 || rz > 25) continue;
            const p = this._proj(m.x, 0, m.z, vw, vh, cx, cy);
            const sw = m.w * p.s * vw;
            const sh = m.h * p.s * vh;
            const fog = Math.max(0, 1 - rz * 0.04);
            if (fog <= 0) continue;

            ctx.globalAlpha = fog;
            const mg = ctx.createLinearGradient(p.x, p.y - sh, p.x, p.y);
            mg.addColorStop(0, `hsl(${m.hue}, 35%, 30%)`);
            mg.addColorStop(1, `hsl(${m.hue}, 25%, 18%)`);
            ctx.fillStyle = mg;

            ctx.beginPath();
            ctx.moveTo(p.x - sw, p.y);
            ctx.lineTo(p.x - sw * 0.2, p.y - sh * 0.9);
            ctx.lineTo(p.x, p.y - sh);
            ctx.lineTo(p.x + sw * 0.3, p.y - sh * 0.7);
            ctx.lineTo(p.x + sw, p.y);
            ctx.closePath();
            ctx.fill();

            if (m.snow) {
                ctx.fillStyle = `rgba(230, 240, 255, ${fog * 0.6})`;
                ctx.beginPath();
                ctx.moveTo(p.x - sw * 0.12, p.y - sh * 0.8);
                ctx.lineTo(p.x, p.y - sh);
                ctx.lineTo(p.x + sw * 0.15, p.y - sh * 0.65);
                ctx.closePath();
                ctx.fill();
            }
            ctx.globalAlpha = 1;
        }
    }

    _drawClouds(ctx, vw, vh, cx, cy) {
        for (const c of this.clouds) {
            const rz = c.z - this.worldZ;
            if (rz < 0.5 || rz > 20) continue;
            const p = this._proj(c.x, c.y + 1.0, c.z, vw, vh, cx, cy);
            const cw = Math.max(1, c.w * p.s * vw);
            const ch = Math.max(1, c.h * p.s * vh);
            const fog = Math.max(0, 1 - rz * 0.05);
            ctx.globalAlpha = c.op * fog;
            ctx.fillStyle = "#e8edf5";
            ctx.beginPath();
            ctx.ellipse(p.x, p.y, cw, ch, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.ellipse(p.x - cw * 0.4, p.y + ch * 0.2, cw * 0.6, ch * 0.7, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
        }
    }

    _drawRings(ctx, vw, vh, cx, cy) {
        for (const r of this.rings) {
            if (r.passed) continue;
            const rz = r.z - this.worldZ;
            if (rz < 0.15 || rz > 18) continue;
            const wx = this._tunnelToWorldX(r.x);
            const wy = this._tunnelToWorldY(r.y || 0);
            const p = this._proj(wx, wy, r.z, vw, vh, cx, cy);
            const rs = Math.max(2, r.size * p.s * vw);
            const fog = Math.max(0.2, 1 - rz * 0.03);

            ctx.save();
            ctx.globalAlpha = fog;
            ctx.strokeStyle = "#FFD700";
            ctx.lineWidth = Math.max(2.5, rs * 0.12);
            ctx.shadowBlur = rs * 0.45;
            ctx.shadowColor = "#FFD700";
            ctx.beginPath();
            ctx.ellipse(p.x, p.y, rs, rs * 0.68, 0, 0, Math.PI * 2);
            ctx.stroke();
            ctx.strokeStyle = "#FFA000";
            ctx.lineWidth = Math.max(1, rs * 0.05);
            ctx.beginPath();
            ctx.ellipse(p.x, p.y, rs * 0.84, rs * 0.56, 0, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
        }
    }

    _drawObs(ctx, vw, vh, cx, cy) {
        const sorted = [...this.obstacles].sort((a, b) => b.z - a.z);
        for (const o of sorted) {
            const rz = o.z - this.worldZ;
            if (rz < 0.15 || rz > 20) continue;
            const wx = this._tunnelToWorldX(o.x);
            const pBase = this._proj(wx, 0, o.z, vw, vh, cx, cy);
            const pTop = this._proj(wx, o.h, o.z, vw, vh, cx, cy);
            const ow = Math.max(2, o.w * 0.68 * pBase.s * vw);
            const oh = Math.max(2, pBase.y - pTop.y);
            const fog = Math.max(0.18, 1 - rz * 0.04);

            const rg = ctx.createLinearGradient(pBase.x - ow, 0, pBase.x + ow, 0);
            rg.addColorStop(0, `rgba(80, 60, 50, ${fog})`);
            rg.addColorStop(0.5, `rgba(130, 96, 76, ${fog})`);
            rg.addColorStop(1, `rgba(65, 48, 38, ${fog})`);
            ctx.fillStyle = rg;
            ctx.beginPath();
            ctx.moveTo(pBase.x - ow, pBase.y);
            ctx.lineTo(pBase.x - ow * 0.58, pBase.y - oh);
            ctx.lineTo(pBase.x + ow * 0.58, pBase.y - oh);
            ctx.lineTo(pBase.x + ow, pBase.y);
            ctx.closePath();
            ctx.fill();

            if (rz < 4.5 && !o.hit) {
                const u = Math.max(0, 1 - rz / 4.5);
                ctx.strokeStyle = `rgba(255, 65, 65, ${u * 0.7})`;
                ctx.lineWidth = 2;
                ctx.stroke();
            }
        }
    }

    _drawCrystals(ctx, vw, vh, cx, cy) {
        const t = this.wingPhase * 0.6;
        for (const cr of this.crystals) {
            if (cr.collected) continue;
            const rz = cr.z - this.worldZ;
            if (rz < 0.15 || rz > 18) continue;
            const wx = this._tunnelToWorldX(cr.x);
            const wy = this._tunnelToWorldY(cr.y || 0) + Math.sin(t + cr.phase) * 0.018;
            const p = this._proj(wx, wy, cr.z, vw, vh, cx, cy);
            const cs = Math.max(2, cr.size * p.s * vw);
            const fog = Math.max(0.22, 1 - rz * 0.035);

            ctx.save();
            ctx.globalAlpha = fog;
            ctx.shadowBlur = cs * 3.5;
            ctx.shadowColor = "#00f2fe";

            ctx.fillStyle = "#00e5ff";
            ctx.beginPath();
            ctx.moveTo(p.x, p.y - cs * 1.25);
            ctx.lineTo(p.x + cs * 0.75, p.y);
            ctx.lineTo(p.x, p.y + cs * 0.65);
            ctx.lineTo(p.x - cs * 0.75, p.y);
            ctx.closePath();
            ctx.fill();

            ctx.fillStyle = "rgba(255,255,255,0.65)";
            ctx.beginPath();
            ctx.moveTo(p.x, p.y - cs * 0.85);
            ctx.lineTo(p.x + cs * 0.32, p.y - cs * 0.1);
            ctx.lineTo(p.x - cs * 0.22, p.y - cs * 0.2);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
        }
    }

    _drawParts(ctx, vw, vh, cx, cy) {
        ctx.save();
        for (const p of this.particles) {
            if (p.z !== undefined) {
                const pr = this._proj(p.x, p.y, p.z, vw, vh, cx, cy);
                const ps = Math.max(0.5, p.size * pr.s * vw);
                ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
                ctx.fillStyle = p.color;
                if (p.type === "line") {
                    ctx.fillRect(pr.x - 1, pr.y, 2, ps * 25);
                } else {
                    ctx.beginPath();
                    ctx.arc(pr.x, pr.y, Math.max(1, ps), 0, Math.PI * 2);
                    ctx.fill();
                }
            } else {
                const pr = this._proj(
                    this._tunnelToWorldX(p.x),
                    this._tunnelToWorldY(p.y),
                    this.worldZ + 1.0,
                    vw,
                    vh,
                    cx,
                    cy
                );
                ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
                ctx.fillStyle = p.color;
                ctx.beginPath();
                ctx.arc(pr.x, pr.y, Math.max(1.5, p.size * Math.min(vw, vh)), 0, Math.PI * 2);
                ctx.fill();
            }
        }
        ctx.restore();
    }

    _drawDragon(ctx, vw, vh, cx, cy) {
        const dragonZ = this.worldZ + 1.0;
        const wx = this._tunnelToWorldX(this.dragonX);
        const wy = this._tunnelToWorldY(this.dragonY);
        const pos = this._proj(wx, wy, dragonZ, vw, vh, cx, cy);
        const shadowPos = this._proj(wx, 0, dragonZ, vw, vh, cx, cy);
        const sc = Math.max(0.55, Math.min(vw, vh) * 0.00175);

        // Тінь дракона на землі для точного сприйняття висоти та курсу
        ctx.save();
        const heightFactor = Math.max(0.25, 1 - wy * 0.85);
        ctx.fillStyle = `rgba(0, 0, 0, ${0.32 * heightFactor})`;
        ctx.beginPath();
        ctx.ellipse(shadowPos.x, shadowPos.y, 38 * sc * heightFactor, 11 * sc * heightFactor, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        ctx.save();
        if (this.hitCooldown > 0 && this.isAlive && Math.floor(this.wingPhase * 4) % 2 === 0) {
            ctx.globalAlpha = 0.42;
        }

        ctx.translate(pos.x, pos.y);
        ctx.rotate((this.dragonTilt * Math.PI) / 180);
        ctx.scale(sc, sc * (1 - this.dragonPitchAngle * 0.004));

        const wA = Math.sin(this.wingPhase) * 0.52;

        // Хвіст
        ctx.strokeStyle = "#2E7D32";
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(0, 30);
        ctx.quadraticCurveTo(-12 + Math.sin(this.wingPhase * 0.7) * 15, 60, -5 + Math.sin(this.wingPhase * 0.5) * 20, 80);
        ctx.stroke();

        ctx.fillStyle = "#FF6F00";
        const tx = -5 + Math.sin(this.wingPhase * 0.5) * 20;
        ctx.beginPath();
        ctx.moveTo(tx, 80);
        ctx.lineTo(tx - 8, 92);
        ctx.lineTo(tx + 8, 92);
        ctx.closePath();
        ctx.fill();

        // Крила
        this._drawWing(ctx, -15, -5, -1, wA);
        this._drawWing(ctx, 15, -5, 1, wA);

        // Тулуб
        const bg = ctx.createLinearGradient(0, -30, 0, 35);
        bg.addColorStop(0, "#2E7D32");
        bg.addColorStop(0.5, "#43A047");
        bg.addColorStop(1, "#1B5E20");
        ctx.fillStyle = bg;
        ctx.beginPath();
        ctx.ellipse(0, 10, 16, 30, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = "#A5D6A7";
        ctx.beginPath();
        ctx.ellipse(0, 14, 10, 18, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,0.08)";
        ctx.lineWidth = 0.5;
        for (let i = -2; i <= 2; i++) {
            ctx.beginPath();
            ctx.moveTo(-8, 10 + i * 6);
            ctx.lineTo(8, 10 + i * 6);
            ctx.stroke();
        }

        // Лапи
        ctx.fillStyle = "#2E7D32";
        ctx.beginPath();
        ctx.ellipse(-12, 30, 5, 8, -0.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(12, 30, 5, 8, 0.3, 0, Math.PI * 2);
        ctx.fill();

        // Шия та голова (з легким нахилом за тангажем)
        const headShiftY = -this.dragonPitchAngle * 0.45;
        ctx.fillStyle = "#2E7D32";
        ctx.beginPath();
        ctx.moveTo(-8, -20);
        ctx.quadraticCurveTo(-4, -42 + headShiftY * 0.5, 0, -50 + headShiftY);
        ctx.quadraticCurveTo(4, -42 + headShiftY * 0.5, 8, -20);
        ctx.closePath();
        ctx.fill();

        const hg = ctx.createRadialGradient(0, -54 + headShiftY, 0, 0, -54 + headShiftY, 14);
        hg.addColorStop(0, "#43A047");
        hg.addColorStop(1, "#2E7D32");
        ctx.fillStyle = hg;
        ctx.beginPath();
        ctx.ellipse(0, -54 + headShiftY, 14, 12, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = "#388E3C";
        ctx.beginPath();
        ctx.ellipse(0, -65 + headShiftY, 9, 6, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#1B5E20";
        ctx.beginPath();
        ctx.arc(-3, -67 + headShiftY, 1.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(3, -67 + headShiftY, 1.5, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = "#FFD600";
        ctx.beginPath();
        ctx.ellipse(-7, -56 + headShiftY, 4.5, 4, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(7, -56 + headShiftY, 4.5, 4, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#111111";
        ctx.beginPath();
        ctx.ellipse(-7, -56 + headShiftY, 1.5, 3.2, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(7, -56 + headShiftY, 1.5, 3.2, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = "#4E342E";
        ctx.beginPath();
        ctx.moveTo(-11, -62 + headShiftY);
        ctx.lineTo(-17, -76 + headShiftY);
        ctx.lineTo(-8, -64 + headShiftY);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(11, -62 + headShiftY);
        ctx.lineTo(17, -76 + headShiftY);
        ctx.lineTo(8, -64 + headShiftY);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = "#FF6F00";
        for (let i = 0; i < 5; i++) {
            const ry = -48 + headShiftY * (1 - i * 0.2) + i * 15;
            const rs = 5 - i * 0.6;
            ctx.beginPath();
            ctx.moveTo(0, ry - rs);
            ctx.lineTo(-rs * 0.7, ry + rs * 0.4);
            ctx.lineTo(rs * 0.7, ry + rs * 0.4);
            ctx.closePath();
            ctx.fill();
        }

        if (this.speed > 1.3) {
            const fa = Math.min(1, (this.speed - 1.3) * 2);
            const fl = 18 + Math.sin(this.wingPhase * 3) * 6;
            ctx.globalAlpha = fa * 0.8;
            const fg = ctx.createLinearGradient(0, -70 + headShiftY, 0, -70 + headShiftY - fl);
            fg.addColorStop(0, "#FF6F00");
            fg.addColorStop(0.4, "#FF3D00");
            fg.addColorStop(1, "rgba(255,0,0,0)");
            ctx.fillStyle = fg;
            ctx.beginPath();
            ctx.moveTo(-5, -70 + headShiftY);
            ctx.lineTo(0, -70 + headShiftY - fl);
            ctx.lineTo(5, -70 + headShiftY);
            ctx.closePath();
            ctx.fill();
        }

        ctx.restore();
    }

    _drawWing(ctx, tx, ty, dir, wA) {
        ctx.save();
        ctx.translate(tx, ty);
        ctx.rotate(dir * (-wA - 0.3));
        const sp = 85;
        const wh = 28;
        const wg = ctx.createLinearGradient(0, 0, dir * sp, -wh);
        wg.addColorStop(0, "#388E3C");
        wg.addColorStop(1, "rgba(56, 142, 60, 0.3)");
        ctx.fillStyle = wg;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(dir * sp * 0.4, -wh * 1.6, dir * sp, -wh * 0.3);
        ctx.lineTo(dir * sp * 0.8, wh * 0.5);
        ctx.quadraticCurveTo(dir * sp * 0.3, wh * 0.3, 0, 10);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,0.12)";
        ctx.lineWidth = 1;
        for (let i = 1; i <= 3; i++) {
            ctx.beginPath();
            ctx.moveTo(0, i * 2);
            ctx.lineTo(dir * sp * (i / 4), -wh * 0.15 + i * 5);
            ctx.stroke();
        }
        ctx.restore();
    }

    stop() {
        this.active = false;
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        this._cleanupListeners();
        this.particles.length = 0;
        this.mountains.length = 0;
        this.clouds.length = 0;
        this.obstacles.length = 0;
        this.crystals.length = 0;
        this.rings.length = 0;
        this.stars.length = 0;
        this._lastScoreHud = "";
        this._lastStateHud = "";
        if (this.api && typeof this.api.clearCustomHTML === "function") {
            this.api.clearCustomHTML();
        }
    }
}

VRDragonGame.inputRequirements = { directions: 4, inputMode: "4way", mode: "4way" };
if (typeof window.RehabGames.register === "function") {
    window.RehabGames.register("vrdragon", VRDragonGame, { directions: 4, inputMode: "4way", mode: "4way" });
} else {
    window.RehabGames.vrdragon = VRDragonGame;
}
