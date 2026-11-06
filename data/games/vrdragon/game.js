// ============================================================================
// VR Дракон — Стереоскопічний 3D-політ для реабілітації кисті
// RehabDevice IoT | Google Cardboard VR + MPU6050
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

        // Стереоскопічний зсув очей
        this.eyeSeparation = 0.03;

        // Відстеження повороту голови (смартфон у VR-окулярах)
        this.headYaw = 0;
        this.headPitch = 0;
        this._orientHandler = null;
        this._touchHandler = null;

        // Стан дракона
        this.dragonX = 0;
        this.dragonY = 0;
        this.dragonTargetX = 0;
        this.dragonTargetY = 0;
        this.dragonTilt = 0;
        this.wingPhase = 0;

        // Параметри світу
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

        this.headYaw = 0;
        this.headPitch = 0;
        this.dragonX = 0;
        this.dragonY = 0;
        this.dragonTargetX = 0;
        this.dragonTargetY = 0;
        this.dragonTilt = 0;
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
        this.obstacleTimer = 1.2;
        this.crystalTimer = 0.8;
        this.ringTimer = 2.5;
        this.particles = [];
        this._lastScoreHud = "";
        this._lastStateHud = "";

        this._cleanupListeners();
        this._initHeadTracking();
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

    _initHeadTracking() {
        if (typeof DeviceOrientationEvent !== "undefined" &&
            typeof DeviceOrientationEvent.requestPermission === "function") {
            this._touchHandler = () => {
                if (this._touchHandler) {
                    document.removeEventListener("touchstart", this._touchHandler);
                    this._touchHandler = null;
                }
                DeviceOrientationEvent.requestPermission().then(permissionState => {
                    if (this.active && permissionState === "granted") {
                        this._attachOrientation();
                    }
                }).catch(() => {});
            };
            document.addEventListener("touchstart", this._touchHandler, { once: true });
        } else if (typeof window !== "undefined") {
            this._attachOrientation();
        }
    }

    _attachOrientation() {
        if (!this.active) return;
        if (this._orientHandler) {
            window.removeEventListener("deviceorientation", this._orientHandler);
        }
        this._orientHandler = (event) => {
            if (!this.active || !event) return;
            const gamma = Number(event.gamma);
            const beta = Number(event.beta);
            if (Number.isFinite(gamma)) {
                this.headYaw = Math.max(-0.35, Math.min(0.35, gamma * 0.012));
            }
            if (Number.isFinite(beta)) {
                this.headPitch = Math.max(-0.35, Math.min(0.35, (beta - 70) * 0.008));
            }
        };
        window.addEventListener("deviceorientation", this._orientHandler);
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
            x: side * (0.8 + Math.random() * 1.0),
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
            x: (Math.random() - 0.5) * 1.4,
            z,
            w: 0.1 + Math.random() * 0.1,
            h: 0.35 + Math.random() * 0.35,
            hit: false
        });
    }

    _spawnCrystal(z) {
        this.crystals.push({
            x: (Math.random() - 0.5) * 1.6,
            y: (Math.random() - 0.5) * 0.35,
            z,
            collected: false,
            phase: Math.random() * Math.PI * 2,
            size: 0.038
        });
    }

    _spawnRing(z) {
        this.rings.push({
            x: (Math.random() - 0.5) * 1.2,
            y: (Math.random() - 0.5) * 0.3,
            z,
            passed: false,
            size: 0.15,
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
        this.dragonTargetY = axes.y;

        if (step === 0) {
            this.dragonX = this.dragonTargetX;
            this.dragonY = this.dragonTargetY;
            this._updateHUD();
            return;
        }

        const prevX = this.dragonX;
        const blend = Math.min(1, step * 7);
        this.dragonX += (this.dragonTargetX - this.dragonX) * blend;
        this.dragonY += (this.dragonTargetY - this.dragonY) * blend;

        const dX = this.dragonX - prevX;
        const targetTilt = Math.max(-30, Math.min(30, -dX * 600));
        this.dragonTilt += (targetTilt - this.dragonTilt) * Math.min(1, step * 5);

        this.wingPhase += step * 5;
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
            this.obstacleTimer = Math.max(1, 3.5 - this.difficultyTimer * 0.015) + Math.random() * 1.5;
        }
        if (this.crystalTimer <= 0) {
            const baseX = (Math.random() - 0.5) * 1.4;
            const baseY = (Math.random() - 0.5) * 0.3;
            const baseZ = this.worldZ + 12 + Math.random() * 6;
            for (let i = 0; i < 3; i++) {
                this.crystals.push({
                    x: Math.max(-0.95, Math.min(0.95, baseX + (i - 1) * 0.12)),
                    y: baseY,
                    z: baseZ + i * 1.2,
                    collected: false,
                    phase: Math.random() * Math.PI * 2,
                    size: 0.04
                });
            }
            this.crystalTimer = 2 + Math.random() * 2;
        }
        if (this.ringTimer <= 0) {
            this._spawnRing(this.worldZ + 15 + Math.random() * 8);
            this.ringTimer = 5 + Math.random() * 5;
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

        if (this.hitCooldown <= 0) {
            for (const o of this.obstacles) {
                if (o.hit) continue;
                const rz = o.z - this.worldZ;
                const fliesOver = this.dragonY > 0.65 && o.h < 0.55;
                if (!fliesOver && rz > 0.3 && rz < 1.5 && Math.abs(this.dragonX - o.x) < o.w + 0.08) {
                    o.hit = true;
                    this.lives--;
                    this.shakeIntensity = 12;
                    this.flashAlpha = 1;
                    this.flashColor = "#ff1744";
                    this.hitCooldown = 2;
                    this.combo = 0;
                    this.score = Math.max(0, this.score - 30);
                    this._burstParticles(this.dragonX, 0.15, "#ff6e40", 12);
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

        for (const cr of this.crystals) {
            if (cr.collected) continue;
            const rz = cr.z - this.worldZ;
            const dy = Math.abs(this.dragonY - (cr.y || 0));
            if (rz > -0.5 && rz < 2.0 && Math.abs(this.dragonX - cr.x) < 0.25 && dy < 0.75) {
                cr.collected = true;
                this.crystalsCollected++;
                this.combo++;
                this.comboTimer = 3;
                this.score += 25 * Math.max(1, this.combo);
                this.bestScore = Math.max(this.bestScore, Math.floor(this.score));
                this.flashAlpha = 0.3;
                this.flashColor = "#00f2fe";
                this._burstParticles(cr.x, 0.15, "#00f2fe", 8);
            }
        }

        for (const r of this.rings) {
            if (r.passed) continue;
            const rz = r.z - this.worldZ;
            const dy = Math.abs(this.dragonY - (r.y || 0));
            if (rz > 0 && rz < 1.5 && Math.abs(this.dragonX - r.x) < r.size + 0.1 && dy < 0.75) {
                r.passed = true;
                this.ringsPassed++;
                this.score += 100;
                this.bestScore = Math.max(this.bestScore, Math.floor(this.score));
                this.combo += 3;
                this.comboTimer = 4;
                this.flashAlpha = 0.4;
                this.flashColor = "#FFD700";
                this._burstParticles(r.x, 0.2, "#FFD700", 16);
            }
        }

        if (this.particles.length < 60 && Math.random() < this.speed * 0.2) {
            this.particles.push({
                x: (Math.random() - 0.5) * 2.5,
                y: Math.random() * 0.6,
                z: this.worldZ + 6 + Math.random() * 4,
                vx: 0,
                vy: 0,
                life: 1,
                ml: 0.3,
                size: 0.003,
                color: "rgba(255,255,255,0.3)",
                type: "line"
            });
        }

        this._updateHUD();
    }

    _burstParticles(x, y, color, count) {
        for (let i = 0; i < count; i++) {
            const angle = Math.random() * Math.PI * 2;
            this.particles.push({
                x,
                y,
                vx: Math.cos(angle) * (0.5 + Math.random()),
                vy: Math.sin(angle) * (0.5 + Math.random()) + 0.5,
                life: 1,
                ml: 0.7,
                size: 0.015 + Math.random() * 0.01,
                color,
                g: 0
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
        const hW = W / 2;

        renderCtx.save();

        // Ліве око
        renderCtx.save();
        renderCtx.beginPath();
        renderCtx.rect(0, 0, hW, H);
        renderCtx.clip();
        this._drawEye(renderCtx, 0, 0, hW, H, -this.eyeSeparation);
        renderCtx.restore();

        // Роздільник стереоекрану
        renderCtx.strokeStyle = "#000000";
        renderCtx.lineWidth = 2;
        renderCtx.beginPath();
        renderCtx.moveTo(hW, 0);
        renderCtx.lineTo(hW, H);
        renderCtx.stroke();

        // Праве око
        renderCtx.save();
        renderCtx.beginPath();
        renderCtx.rect(hW, 0, hW, H);
        renderCtx.clip();
        this._drawEye(renderCtx, hW, 0, hW, H, this.eyeSeparation);
        renderCtx.restore();

        if (this.flashAlpha > 0) {
            renderCtx.globalAlpha = Math.max(0, Math.min(1, this.flashAlpha * 0.15));
            renderCtx.fillStyle = this.flashColor || "#ffffff";
            renderCtx.fillRect(0, 0, W, H);
            renderCtx.globalAlpha = 1;
        }

        if (!this.isAlive) {
            renderCtx.fillStyle = "rgba(10, 0, 0, 0.65)";
            renderCtx.fillRect(0, 0, W, H);
            const titleSize = Math.max(12, Math.min(24, W * 0.035));
            renderCtx.font = `bold ${titleSize}px sans-serif`;
            renderCtx.textAlign = "center";
            renderCtx.fillStyle = "#ff1744";
            renderCtx.fillText("💥 Зіткнення!", W * 0.25, H * 0.42);
            renderCtx.fillText("💥 Зіткнення!", W * 0.75, H * 0.42);

            const subSize = Math.max(10, Math.min(15, W * 0.022));
            renderCtx.font = `${subSize}px sans-serif`;
            renderCtx.fillStyle = "#e0e0e0";
            const sec = Math.max(1, Math.ceil(this.respawnTimer));
            renderCtx.fillText(`Відновлення: ${sec} с...`, W * 0.25, H * 0.51);
            renderCtx.fillText(`Відновлення: ${sec} с...`, W * 0.75, H * 0.51);
        }

        renderCtx.restore();
    }

    _drawEye(ctx, ox, oy, vw, vh, eyeOff) {
        const hx = this.headYaw * vw * 0.12 + eyeOff * vw;
        const hy = this.headPitch * vh * 0.08;
        const sx = this.shakeIntensity > 0 ? (Math.random() - 0.5) * this.shakeIntensity : 0;
        const sy = this.shakeIntensity > 0 ? (Math.random() - 0.5) * this.shakeIntensity : 0;
        const cx = hx + sx;
        const cy = hy + sy;

        this._drawSky(ctx, ox, oy, vw, vh, cy);
        this._drawStars(ctx, ox, oy, vw, vh, cx, cy);
        this._drawSun(ctx, ox, oy, vw, vh, cx, cy);
        this._drawGround(ctx, ox, oy, vw, vh, cx, cy);
        this._drawMtns(ctx, ox, oy, vw, vh, cx, cy);
        this._drawClouds(ctx, ox, oy, vw, vh, cx, cy);
        this._drawRings(ctx, ox, oy, vw, vh, cx, cy);
        this._drawObs(ctx, ox, oy, vw, vh, cx, cy);
        this._drawCrystals(ctx, ox, oy, vw, vh, cx, cy);
        this._drawParts(ctx, ox, oy, vw, vh, cx, cy);
        this._drawDragon(ctx, ox, oy, vw, vh, cx, cy);
        this._drawInEyeHUD(ctx, ox, oy, vw, vh);
    }

    _proj(x, y, z, vw, vh, cx, cy) {
        let rz = z - this.worldZ;
        if (!Number.isFinite(rz) || rz <= 0.1) rz = 0.1;
        const s = 0.5 / rz;
        const cameraHeight = 0.7;
        const horizon = vh * 0.35;

        return {
            x: vw / 2 + x * s * vw + cx,
            y: horizon + (cameraHeight - y) * s * vh + cy,
            s
        };
    }

    _drawSky(ctx, ox, oy, vw, vh, cy) {
        const g = ctx.createLinearGradient(ox, oy + cy * 0.5, ox, oy + vh);
        g.addColorStop(0, "#0b0d2a");
        g.addColorStop(0.15, "#141852");
        g.addColorStop(0.35, "#1e3a6e");
        g.addColorStop(0.55, "#2d6a9f");
        g.addColorStop(0.75, "#4a9ec4");
        g.addColorStop(0.9, "#7ecce5");
        g.addColorStop(1, "#aee8f5");
        ctx.fillStyle = g;
        ctx.fillRect(ox, oy, vw, vh);

        ctx.save();
        ctx.globalAlpha = 0.07;
        ctx.globalCompositeOperation = "screen";
        for (let i = 0; i < 2; i++) {
            const ag = ctx.createLinearGradient(ox, oy + vh * 0.05, ox, oy + vh * 0.25);
            const hue = 160 + i * 50 + Math.sin(this.rainbowPhase + i * 2) * 30;
            ag.addColorStop(0, `hsla(${hue}, 90%, 65%, 0)`);
            ag.addColorStop(0.5, `hsla(${hue}, 90%, 65%, 0.7)`);
            ag.addColorStop(1, `hsla(${hue}, 90%, 65%, 0)`);
            ctx.fillStyle = ag;
            ctx.beginPath();
            ctx.moveTo(ox, oy + vh * 0.08);
            const stepX = Math.max(8, vw / 12);
            for (let x = 0; x <= vw; x += stepX) {
                const y = vh * 0.12 + Math.sin((x / vw) * 5 + this.rainbowPhase * (1 + i * 0.4)) * vh * 0.04;
                ctx.lineTo(ox + x, oy + y + i * vh * 0.04);
            }
            ctx.lineTo(ox + vw, oy + vh * 0.3);
            ctx.lineTo(ox, oy + vh * 0.3);
            ctx.closePath();
            ctx.fill();
        }
        ctx.restore();
    }

    _drawStars(ctx, ox, oy, vw, vh, cx, cy) {
        const t = this.wingPhase * 0.5;
        for (const s of this.stars) {
            const p = this._proj(s.x, s.y + 1.2, this.worldZ + s.z, vw, vh, cx, cy);
            if (p.x < 0 || p.x > vw) continue;
            const tw = 0.4 + 0.6 * Math.sin(t + s.twinkle);
            ctx.fillStyle = `rgba(255,255,255,${tw * 0.7})`;
            ctx.beginPath();
            ctx.arc(ox + p.x, oy + p.y, Math.max(0.5, s.size * p.s * 3), 0, Math.PI * 2);
            ctx.fill();
        }
    }

    _drawSun(ctx, ox, oy, vw, vh, cx, cy) {
        const sunX = ox + vw * 0.7 + cx * 0.3;
        const sunY = oy + vh * 0.12 + cy * 0.2;
        const sunR = Math.max(2, Math.min(vw, vh) * 0.06);

        for (let i = 3; i >= 0; i--) {
            const r = sunR * (1 + i * 0.8);
            const alpha = 0.04 - i * 0.008;
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

    _drawGround(ctx, ox, oy, vw, vh, cx, cy) {
        const horizonY = Math.max(0, Math.min(vh - 1, vh * 0.35 + cy));
        const g = ctx.createLinearGradient(ox, oy + horizonY, ox, oy + vh);
        g.addColorStop(0, "rgba(15, 45, 25, 0.4)");
        g.addColorStop(1, "rgba(8, 25, 15, 0.9)");
        ctx.fillStyle = g;
        ctx.fillRect(ox, oy + horizonY, vw, vh - horizonY);
    }

    _drawMtns(ctx, ox, oy, vw, vh, cx, cy) {
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
            const mg = ctx.createLinearGradient(ox + p.x, oy + p.y - sh, ox + p.x, oy + p.y);
            mg.addColorStop(0, `hsl(${m.hue}, 35%, 30%)`);
            mg.addColorStop(1, `hsl(${m.hue}, 25%, 18%)`);
            ctx.fillStyle = mg;

            ctx.beginPath();
            ctx.moveTo(ox + p.x - sw, oy + p.y);
            ctx.lineTo(ox + p.x - sw * 0.2, oy + p.y - sh * 0.9);
            ctx.lineTo(ox + p.x, oy + p.y - sh);
            ctx.lineTo(ox + p.x + sw * 0.3, oy + p.y - sh * 0.7);
            ctx.lineTo(ox + p.x + sw, oy + p.y);
            ctx.closePath();
            ctx.fill();

            if (m.snow) {
                ctx.fillStyle = `rgba(230, 240, 255, ${fog * 0.6})`;
                ctx.beginPath();
                ctx.moveTo(ox + p.x - sw * 0.12, oy + p.y - sh * 0.8);
                ctx.lineTo(ox + p.x, oy + p.y - sh);
                ctx.lineTo(ox + p.x + sw * 0.15, oy + p.y - sh * 0.65);
                ctx.closePath();
                ctx.fill();
            }
            ctx.globalAlpha = 1;
        }
    }

    _drawClouds(ctx, ox, oy, vw, vh, cx, cy) {
        for (const c of this.clouds) {
            const rz = c.z - this.worldZ;
            if (rz < 0.5 || rz > 20) continue;
            const p = this._proj(c.x, c.y + 1.2, c.z, vw, vh, cx, cy);
            const cw = Math.max(1, c.w * p.s * vw);
            const ch = Math.max(1, c.h * p.s * vh);
            const fog = Math.max(0, 1 - rz * 0.05);
            ctx.globalAlpha = c.op * fog;
            ctx.fillStyle = "#e8edf5";
            ctx.beginPath();
            ctx.ellipse(ox + p.x, oy + p.y, cw, ch, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.ellipse(ox + p.x - cw * 0.4, oy + p.y + ch * 0.2, cw * 0.6, ch * 0.7, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
        }
    }

    _drawRings(ctx, ox, oy, vw, vh, cx, cy) {
        for (const r of this.rings) {
            if (r.passed) continue;
            const rz = r.z - this.worldZ;
            if (rz < 0 || rz > 18) continue;
            const p = this._proj(r.x, 0.3 + (r.y || 0) * 0.2, r.z, vw, vh, cx, cy);
            const rs = Math.max(1, r.size * p.s * vw);
            const fog = Math.max(0.2, 1 - rz * 0.03);

            ctx.save();
            ctx.globalAlpha = fog;
            ctx.strokeStyle = "#FFD700";
            ctx.lineWidth = Math.max(2, rs * 0.1);
            ctx.shadowBlur = rs * 0.5;
            ctx.shadowColor = "#FFD700";
            ctx.beginPath();
            ctx.ellipse(ox + p.x, oy + p.y, rs, rs * 0.6, 0, 0, Math.PI * 2);
            ctx.stroke();
            ctx.strokeStyle = "#FFA000";
            ctx.lineWidth = Math.max(1, rs * 0.05);
            ctx.beginPath();
            ctx.ellipse(ox + p.x, oy + p.y, rs * 0.85, rs * 0.5, 0, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
        }
    }

    _drawObs(ctx, ox, oy, vw, vh, cx, cy) {
        const sorted = [...this.obstacles].sort((a, b) => b.z - a.z);
        for (const o of sorted) {
            const rz = o.z - this.worldZ;
            if (rz < -0.5 || rz > 20) continue;
            const p = this._proj(o.x, 0, o.z, vw, vh, cx, cy);
            const ow = Math.max(1, o.w * p.s * vw);
            const oh = Math.max(1, o.h * p.s * vh);
            const fog = Math.max(0.15, 1 - rz * 0.04);

            const rg = ctx.createLinearGradient(ox + p.x - ow, 0, ox + p.x + ow, 0);
            rg.addColorStop(0, `rgba(80, 60, 50, ${fog})`);
            rg.addColorStop(0.5, `rgba(120, 90, 70, ${fog})`);
            rg.addColorStop(1, `rgba(70, 50, 40, ${fog})`);
            ctx.fillStyle = rg;
            ctx.beginPath();
            ctx.moveTo(ox + p.x - ow, oy + p.y);
            ctx.lineTo(ox + p.x - ow * 0.6, oy + p.y - oh);
            ctx.lineTo(ox + p.x + ow * 0.6, oy + p.y - oh);
            ctx.lineTo(ox + p.x + ow, oy + p.y);
            ctx.closePath();
            ctx.fill();

            if (rz < 4 && !o.hit) {
                const u = Math.max(0, 1 - rz / 4);
                ctx.strokeStyle = `rgba(255, 50, 50, ${u * 0.6})`;
                ctx.lineWidth = 2;
                ctx.stroke();
            }
        }
    }

    _drawCrystals(ctx, ox, oy, vw, vh, cx, cy) {
        const t = this.wingPhase * 0.6;
        for (const cr of this.crystals) {
            if (cr.collected) continue;
            const rz = cr.z - this.worldZ;
            if (rz < 0 || rz > 18) continue;
            const bobY = 0.3 + (cr.y || 0) * 0.2 + Math.sin(t + cr.phase) * 0.02;
            const p = this._proj(cr.x, bobY, cr.z, vw, vh, cx, cy);
            const cs = Math.max(1, cr.size * p.s * vw);
            const fog = Math.max(0.2, 1 - rz * 0.035);

            ctx.save();
            ctx.globalAlpha = fog;
            ctx.shadowBlur = cs * 4;
            ctx.shadowColor = "#00f2fe";

            ctx.fillStyle = "#00e5ff";
            ctx.beginPath();
            ctx.moveTo(ox + p.x, oy + p.y - cs * 1.2);
            ctx.lineTo(ox + p.x + cs * 0.7, oy + p.y);
            ctx.lineTo(ox + p.x, oy + p.y + cs * 0.5);
            ctx.lineTo(ox + p.x - cs * 0.7, oy + p.y);
            ctx.closePath();
            ctx.fill();

            ctx.fillStyle = "rgba(255,255,255,0.6)";
            ctx.beginPath();
            ctx.moveTo(ox + p.x, oy + p.y - cs * 0.8);
            ctx.lineTo(ox + p.x + cs * 0.3, oy + p.y - cs * 0.1);
            ctx.lineTo(ox + p.x - cs * 0.2, oy + p.y - cs * 0.2);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
        }
    }

    _drawParts(ctx, ox, oy, vw, vh, cx, cy) {
        ctx.save();
        for (const p of this.particles) {
            if (p.z !== undefined) {
                const pr = this._proj(p.x, p.y, p.z, vw, vh, cx, cy);
                const ps = Math.max(0.5, p.size * pr.s * vw);
                ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
                ctx.fillStyle = p.color;
                if (p.type === "line") {
                    ctx.fillRect(ox + pr.x - 1, oy + pr.y, 2, ps * 25);
                } else {
                    ctx.beginPath();
                    ctx.arc(ox + pr.x, oy + pr.y, Math.max(1, ps), 0, Math.PI * 2);
                    ctx.fill();
                }
            } else {
                ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
                ctx.fillStyle = p.color;
                ctx.beginPath();
                ctx.arc(ox + vw / 2 + p.x * vw * 0.3, oy + vh * 0.45 + p.y * vh * 0.2, Math.max(1, p.size * vw), 0, Math.PI * 2);
                ctx.fill();
            }
        }
        ctx.restore();
    }

    _drawDragon(ctx, ox, oy, vw, vh, cx, cy) {
        const dx = vw / 2 + this.dragonX * vw * 0.3 + cx;
        const dy = vh * (0.74 - this.dragonY * 0.14) + cy;
        const sc = Math.max(0.45, Math.min(vw, vh) * 0.0018);

        ctx.save();
        if (this.hitCooldown > 0 && this.isAlive && Math.floor(this.wingPhase * 4) % 2 === 0) {
            ctx.globalAlpha = 0.4;
        }

        ctx.translate(ox + dx, oy + dy);
        ctx.rotate((this.dragonTilt * Math.PI) / 180);
        ctx.scale(sc, sc);

        const wA = Math.sin(this.wingPhase) * 0.5;

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

        this._drawWing(ctx, -15, -5, -1, wA);
        this._drawWing(ctx, 15, -5, 1, wA);

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

        ctx.fillStyle = "#2E7D32";
        ctx.beginPath();
        ctx.ellipse(-12, 30, 5, 8, -0.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(12, 30, 5, 8, 0.3, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = "#2E7D32";
        ctx.beginPath();
        ctx.moveTo(-8, -20);
        ctx.quadraticCurveTo(-4, -42, 0, -50);
        ctx.quadraticCurveTo(4, -42, 8, -20);
        ctx.closePath();
        ctx.fill();

        const hg = ctx.createRadialGradient(0, -54, 0, 0, -54, 14);
        hg.addColorStop(0, "#43A047");
        hg.addColorStop(1, "#2E7D32");
        ctx.fillStyle = hg;
        ctx.beginPath();
        ctx.ellipse(0, -54, 14, 12, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = "#388E3C";
        ctx.beginPath();
        ctx.ellipse(0, -65, 9, 6, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#1B5E20";
        ctx.beginPath();
        ctx.arc(-3, -67, 1.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(3, -67, 1.5, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = "#FFD600";
        ctx.beginPath();
        ctx.ellipse(-7, -56, 4.5, 4, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(7, -56, 4.5, 4, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#111111";
        ctx.beginPath();
        ctx.ellipse(-7, -56, 1.5, 3.2, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(7, -56, 1.5, 3.2, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = "#4E342E";
        ctx.beginPath();
        ctx.moveTo(-11, -62);
        ctx.lineTo(-17, -76);
        ctx.lineTo(-8, -64);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(11, -62);
        ctx.lineTo(17, -76);
        ctx.lineTo(8, -64);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = "#FF6F00";
        for (let i = 0; i < 5; i++) {
            const ry = -48 + i * 15;
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
            const fg = ctx.createLinearGradient(0, -70, 0, -70 - fl);
            fg.addColorStop(0, "#FF6F00");
            fg.addColorStop(0.4, "#FF3D00");
            fg.addColorStop(1, "rgba(255,0,0,0)");
            ctx.fillStyle = fg;
            ctx.beginPath();
            ctx.moveTo(-5, -70);
            ctx.lineTo(0, -70 - fl);
            ctx.lineTo(5, -70);
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

    _drawInEyeHUD(ctx, ox, oy, vw, vh) {
        ctx.save();
        const fs = Math.max(8, Math.min(11, vw * 0.045));
        ctx.font = `bold ${fs}px sans-serif`;

        const barW = vw * 0.9;
        const barX = ox + (vw - barW) / 2;
        const barY = oy + 8;

        ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
        if (typeof ctx.roundRect === "function") {
            ctx.beginPath();
            ctx.roundRect(barX, barY, barW, fs + 10, 6);
            ctx.fill();
        } else {
            ctx.fillRect(barX, barY, barW, fs + 10);
        }

        const hearts = "♥".repeat(Math.max(0, this.lives)) + "♡".repeat(Math.max(0, 3 - this.lives));

        ctx.textAlign = "left";
        ctx.fillStyle = "#FFD700";
        ctx.fillText(`★ ${Math.floor(this.score)}`, barX + 6, barY + fs + 3);

        ctx.textAlign = "center";
        const comboStr = this.combo > 1 ? ` x${this.combo}` : "";
        ctx.fillStyle = "#00e5ff";
        ctx.fillText(`◆ ${this.crystalsCollected}${comboStr}`, ox + vw / 2, barY + fs + 3);

        ctx.textAlign = "right";
        ctx.fillStyle = "#ff5252";
        ctx.fillText(hearts, barX + barW - 6, barY + fs + 3);

        const dist = Math.floor(this.distanceTraveled);
        ctx.textAlign = "center";
        ctx.fillStyle = "rgba(255,255,255,0.6)";
        ctx.font = `${Math.max(8, Math.min(10, vw * 0.035))}px sans-serif`;
        ctx.fillText(`${dist} м | Шв. x${this.speed.toFixed(1)}`, ox + vw / 2, oy + vh - 8);
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

VRDragonGame.inputRequirements = { directions: 4, mode: "4way" };
if (typeof window.RehabGames.register === "function") {
    window.RehabGames.register("vrdragon", VRDragonGame, { directions: 4, mode: "4way" });
} else {
    window.RehabGames.vrdragon = VRDragonGame;
}
