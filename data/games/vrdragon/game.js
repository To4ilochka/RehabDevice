// ============================================================================
// 🐉 VR Dragon Flight v3 — True 3D Perspective (Camera above & behind)
// RehabDevice IoT | Google Cardboard VR + MPU6050
// ============================================================================

window.RehabGames = window.RehabGames || {};

window.RehabGames['vrdragon'] = class VRDragonGame {
    constructor(ctx, api) {
        this.ctx = ctx;
        this.api = api;
        this.width = ctx.canvas.width;
        this.height = ctx.canvas.height;

        this.calibMin = -20;
        this.calibMax = 20;

        // VR stereo
        this.eyeSeparation = 0.03;

        // Head tracking
        this.headYaw = 0;
        this.headPitch = 0;
        this._initHeadTracking();

        // Dragon
        this.dragonX = 0;
        this.dragonTargetX = 0;
        this.dragonTilt = 0;
        this.wingPhase = 0;

        // World
        this.worldZ = 0;
        this.speed = 1.0;
        this.baseSpeed = 80;

        // Objects
        this.mountains = [];
        this.clouds = [];
        this.crystals = [];
        this.obstacles = [];
        this.rings = [];
        this.stars = [];

        // Score
        this.score = 0;
        this.crystalsCollected = 0;
        this.ringsPassed = 0;
        this.distanceTraveled = 0;
        this.bestScore = 0;
        this.lives = 3;
        this.hitCooldown = 0;
        this.isAlive = true;
        this.respawnTimer = 0;

        // Effects
        this.particles = [];
        this.shakeIntensity = 0;
        this.flashAlpha = 0;
        this.flashColor = '';
        this.comboTimer = 0;
        this.combo = 0;

        // Difficulty
        this.difficultyTimer = 0;
        this.obstacleTimer = 0;
        this.crystalTimer = 0;
        this.ringTimer = 0;

        // Visuals
        this.rainbowPhase = 0;
        this.sunGlow = 0;
    }

    init(calibMin, calibMax) {
        this.calibMin = calibMin;
        this.calibMax = calibMax;
        this.resize(this.ctx.canvas.width, this.ctx.canvas.height);
        this.score = 0;
        this.crystalsCollected = 0;
        this.ringsPassed = 0;
        this.distanceTraveled = 0;
        this.lives = 3;
        this.isAlive = true;
        this.dragonX = 0;
        this.worldZ = 0;
        this.speed = 1.0;
        this.difficultyTimer = 0;
        this.combo = 0;
        this.particles = [];
        this._initWorld();
        this._updateHUD();
    }

    resize(w, h) { this.width = w; this.height = h; }

    _initHeadTracking() {
        if (typeof DeviceOrientationEvent !== 'undefined' &&
            typeof DeviceOrientationEvent.requestPermission === 'function') {
            const h = () => {
                DeviceOrientationEvent.requestPermission().then(s => {
                    if (s === 'granted') this._attachOrientation();
                }).catch(() => {});
                document.removeEventListener('touchstart', h);
            };
            document.addEventListener('touchstart', h, { once: true });
        } else {
            this._attachOrientation();
        }
    }

    _attachOrientation() {
        this._orientHandler = (e) => {
            if (e.gamma !== null) {
                this.headYaw = (e.gamma || 0) * 0.012;
                this.headPitch = ((e.beta || 0) - 70) * 0.008;
            }
        };
        window.addEventListener('deviceorientation', this._orientHandler);
    }

    // === WORLD ===
    _initWorld() {
        this.stars = [];
        for (let i = 0; i < 100; i++) {
            this.stars.push({
                x: (Math.random() - 0.5) * 5,
                y: Math.random() * 0.5,
                z: 5 + Math.random() * 25,
                size: 0.5 + Math.random() * 2,
                twinkle: Math.random() * 6.28
            });
        }
        this.mountains = [];
        for (let z = 3; z < 35; z += 1.5 + Math.random() * 2) this._spawnMountain(z);
        this.clouds = [];
        for (let z = 3; z < 25; z += 2 + Math.random() * 3) this._spawnCloud(z);
        this.obstacles = [];
        this.crystals = [];
        this.rings = [];
    }

    _spawnMountain(z) {
        let side = Math.random() > 0.5 ? 1 : -1;
        this.mountains.push({
            x: side * (0.8 + Math.random() * 1.0),
            z, w: 0.5 + Math.random() * 0.8, h: 0.4 + Math.random() * 0.6,
            hue: 100 + Math.random() * 60, snow: Math.random() > 0.35
        });
    }

    _spawnCloud(z) {
        this.clouds.push({
            x: (Math.random() - 0.5) * 3, y: 0.3 + Math.random() * 0.3, z,
            w: 0.2 + Math.random() * 0.35, h: 0.06 + Math.random() * 0.08,
            op: 0.2 + Math.random() * 0.3
        });
    }

    _spawnObstacle(z) {
        this.obstacles.push({
            x: (Math.random() - 0.5) * 1.4, z,
            w: 0.1 + Math.random() * 0.1, h: 0.4 + Math.random() * 0.4, hit: false
        });
    }

    _spawnCrystal(z) {
        this.crystals.push({
            x: (Math.random() - 0.5) * 1.6, z,
            collected: false, phase: Math.random() * 6.28, size: 0.035
        });
    }

    _spawnRing(z) {
        this.rings.push({
            x: (Math.random() - 0.5) * 1.2, z,
            passed: false, size: 0.15, phase: Math.random() * 6.28
        });
    }

    // === UPDATE ===
    update(dt, currentAngle) {
        if (dt > 0.1) dt = 0.016;

        let bc = false;
        if (currentAngle > this.calibMax) { this.calibMax += (currentAngle - this.calibMax) * 0.05; bc = true; }
        if (currentAngle < this.calibMin) { this.calibMin -= (this.calibMin - currentAngle) * 0.05; bc = true; }
        if (bc) this.api.updateCalibration(this.calibMin, this.calibMax);

        let range = this.calibMax - this.calibMin;
        let norm = range > 0 ? (currentAngle - this.calibMin) / range : 0.5;
        norm = Math.max(0, Math.min(1, norm));
        this.dragonTargetX = (norm - 0.5) * 2;

        let prevX = this.dragonX;
        this.dragonX += (this.dragonTargetX - this.dragonX) * 7 * dt;

        let dX = this.dragonX - prevX;
        let tgtTilt = Math.max(-30, Math.min(30, -dX * 600));
        this.dragonTilt += (tgtTilt - this.dragonTilt) * 5 * dt;

        this.wingPhase += dt * 5;
        this.rainbowPhase += dt * 0.8;
        this.sunGlow += dt * 2;

        this.shakeIntensity *= Math.pow(0.02, dt);
        if (this.shakeIntensity < 0.3) this.shakeIntensity = 0;
        this.flashAlpha = Math.max(0, this.flashAlpha - dt * 4);
        this.hitCooldown = Math.max(0, this.hitCooldown - dt);

        for (let i = this.particles.length - 1; i >= 0; i--) {
            let p = this.particles[i];
            p.life -= dt / p.ml;
            p.x += p.vx * dt; p.y += p.vy * dt;
            p.vy += (p.g || 0) * dt;
            if (p.life <= 0) this.particles.splice(i, 1);
        }

        if (!this.isAlive) {
            this.respawnTimer -= dt;
            if (this.respawnTimer <= 0) {
                this.isAlive = true;
                this.hitCooldown = 2;
            }
            this._updateHUD();
            return;
        }

        let moveSpd = this.baseSpeed * this.speed * dt;
        this.worldZ += moveSpd * 0.05;
        this.distanceTraveled += moveSpd;
        this.score += dt * 10 * this.speed;

        this.difficultyTimer += dt;
        this.speed = Math.min(2.5, 1.0 + this.difficultyTimer * 0.008);

        this.comboTimer -= dt;
        if (this.comboTimer <= 0) this.combo = 0;

        this.obstacleTimer -= dt;
        this.crystalTimer -= dt;
        this.ringTimer -= dt;
        if (this.obstacleTimer <= 0) {
            this._spawnObstacle(this.worldZ + 18 + Math.random() * 5);
            this.obstacleTimer = Math.max(1, 3.5 - this.difficultyTimer * 0.015) + Math.random() * 1.5;
        }
        if (this.crystalTimer <= 0) {
            let baseX = (Math.random() - 0.5) * 1.4;
            let baseZ = this.worldZ + 12 + Math.random() * 6;
            for (let i = 0; i < 3; i++) {
                this.crystals.push({
                    x: baseX + (i - 1) * 0.12, z: baseZ + i * 1.2,
                    collected: false, phase: Math.random() * 6.28, size: 0.04
                });
            }
            this.crystalTimer = 2 + Math.random() * 2;
        }
        if (this.ringTimer <= 0) {
            this._spawnRing(this.worldZ + 15 + Math.random() * 8);
            this.ringTimer = 5 + Math.random() * 5;
        }

        let mxZ = this.worldZ + 30;
        let lastM = this.mountains.length > 0 ? Math.max(...this.mountains.map(m => m.z)) : 0;
        while (lastM < mxZ) { lastM += 1.5 + Math.random() * 2; this._spawnMountain(lastM); }
        let lastC = this.clouds.length > 0 ? Math.max(...this.clouds.map(c => c.z)) : 0;
        while (lastC < mxZ) { lastC += 2 + Math.random() * 3; this._spawnCloud(lastC); }

        this.mountains = this.mountains.filter(m => m.z > this.worldZ - 2);
        this.clouds = this.clouds.filter(c => c.z > this.worldZ - 2);
        this.obstacles = this.obstacles.filter(o => o.z > this.worldZ - 2);
        this.crystals = this.crystals.filter(c => c.z > this.worldZ - 2);
        this.rings = this.rings.filter(r => r.z > this.worldZ - 2);

        if (this.hitCooldown <= 0) {
            for (let o of this.obstacles) {
                if (o.hit) continue;
                let rz = o.z - this.worldZ;
                if (rz > 0.3 && rz < 1.5 && Math.abs(this.dragonX - o.x) < o.w + 0.08) {
                    o.hit = true;
                    this.lives--;
                    this.shakeIntensity = 12;
                    this.flashAlpha = 1;
                    this.flashColor = '#ff1744';
                    this.hitCooldown = 2;
                    this.combo = 0;
                    this.score = Math.max(0, this.score - 30);
                    this._burstParticles(this.dragonX, 0.15, '#ff6e40', 12);
                    if (this.lives <= 0) {
                        this.isAlive = false;
                        this.respawnTimer = 3;
                        this.lives = 3;
                        this.speed = 1.0;
                        this.difficultyTimer = Math.max(0, this.difficultyTimer - 15);
                    }
                    break;
                }
            }
        }

        for (let cr of this.crystals) {
            if (cr.collected) continue;
            let rz = cr.z - this.worldZ;
            if (rz > -0.5 && rz < 2.0 && Math.abs(this.dragonX - cr.x) < 0.25) {
                cr.collected = true;
                this.crystalsCollected++;
                this.combo++;
                this.comboTimer = 3;
                this.score += 25 * Math.max(1, this.combo);
                this.flashAlpha = 0.3;
                this.flashColor = '#00f2fe';
                this._burstParticles(cr.x, 0.15, '#00f2fe', 8);
            }
        }

        for (let r of this.rings) {
            if (r.passed) continue;
            let rz = r.z - this.worldZ;
            if (rz > 0 && rz < 1.5 && Math.abs(this.dragonX - r.x) < r.size + 0.1) {
                r.passed = true;
                this.ringsPassed++;
                this.score += 100;
                this.combo += 3;
                this.comboTimer = 4;
                this.flashAlpha = 0.4;
                this.flashColor = '#FFD700';
                this._burstParticles(r.x, 0.2, '#FFD700', 20);
            }
        }

        if (Math.random() < this.speed * 0.2) {
            this.particles.push({
                x: (Math.random() - 0.5) * 2.5, y: Math.random() * 0.6, z: this.worldZ + 6 + Math.random() * 4,
                vx: 0, vy: 0, life: 1, ml: 0.3, size: 0.003, color: 'rgba(255,255,255,0.3)', type: 'line'
            });
        }

        this._updateHUD();
    }

    _burstParticles(x, y, color, count) {
        for (let i = 0; i < count; i++) {
            let a = Math.random() * 6.28;
            this.particles.push({
                x, y, vx: Math.cos(a) * (0.5 + Math.random()),
                vy: Math.sin(a) * (0.5 + Math.random()) + 0.5,
                life: 1, ml: 0.7, size: 0.015 + Math.random() * 0.01,
                color, g: 0
            });
        }
    }

    _updateHUD() {
        let h = '❤️'.repeat(this.lives) + '🖤'.repeat(3 - this.lives);
        let c = this.combo > 1 ? ` | 🔥x${this.combo}` : '';
        this.api.updateHUD("hudScore", `🐉 ${Math.floor(this.score)} | 💎${this.crystalsCollected} | ${h}${c}`);
        this.api.updateHUD("hudBotState", `${Math.floor(this.distanceTraveled)}м | ⚡x${this.speed.toFixed(1)}`);
    }

    // === DRAW ===
    draw() {
        const ctx = this.ctx;
        const W = this.width;
        const H = this.height;
        const hW = W / 2;

        ctx.save();

        ctx.save();
        ctx.beginPath(); ctx.rect(0, 0, hW, H); ctx.clip();
        this._drawEye(ctx, 0, 0, hW, H, -this.eyeSeparation);
        ctx.restore();

        ctx.strokeStyle = '#000';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(hW, 0); ctx.lineTo(hW, H); ctx.stroke();

        ctx.save();
        ctx.beginPath(); ctx.rect(hW, 0, hW, H); ctx.clip();
        this._drawEye(ctx, hW, 0, hW, H, this.eyeSeparation);
        ctx.restore();

        if (this.flashAlpha > 0) {
            ctx.globalAlpha = this.flashAlpha * 0.15;
            ctx.fillStyle = this.flashColor;
            ctx.fillRect(0, 0, W, H);
            ctx.globalAlpha = 1;
        }

        if (!this.isAlive) {
            ctx.fillStyle = 'rgba(10, 0, 0, 0.65)';
            ctx.fillRect(0, 0, W, H);
            let fs = Math.min(26, W * 0.035);
            ctx.font = `bold ${fs}px 'Inter', sans-serif`;
            ctx.textAlign = 'center';
            ctx.fillStyle = '#ff1744';
            ctx.fillText('💥 Зіткнення!', W * 0.25, H * 0.4);
            ctx.fillText('💥 Зіткнення!', W * 0.75, H * 0.4);
            let fs2 = Math.min(15, W * 0.022);
            ctx.font = `${fs2}px 'Inter', sans-serif`;
            ctx.fillStyle = '#aaa';
            let sec = Math.ceil(this.respawnTimer);
            ctx.fillText(`${sec}с...`, W * 0.25, H * 0.5);
            ctx.fillText(`${sec}с...`, W * 0.75, H * 0.5);
        }

        ctx.restore();
    }

    _drawEye(ctx, ox, oy, vw, vh, eyeOff) {
        let hx = this.headYaw * vw * 0.12 + eyeOff * vw;
        let hy = this.headPitch * vh * 0.08;
        let sx = this.shakeIntensity > 0 ? (Math.random() - 0.5) * this.shakeIntensity : 0;
        let sy = this.shakeIntensity > 0 ? (Math.random() - 0.5) * this.shakeIntensity : 0;
        let cx = hx + sx, cy = hy + sy;

        // Correct 3D Drawing Order
        this._drawSky(ctx, ox, oy, vw, vh, cy);
        this._drawStars(ctx, ox, oy, vw, vh, cx, cy);
        this._drawSun(ctx, ox, oy, vw, vh, cx, cy);
        this._drawGround(ctx, ox, oy, vw, vh, cx, cy); // Ground is drawn before 3D objects
        this._drawMtns(ctx, ox, oy, vw, vh, cx, cy);
        this._drawClouds(ctx, ox, oy, vw, vh, cx, cy);
        this._drawRings(ctx, ox, oy, vw, vh, cx, cy);
        this._drawObs(ctx, ox, oy, vw, vh, cx, cy);
        this._drawCrystals(ctx, ox, oy, vw, vh, cx, cy);
        this._drawParts(ctx, ox, oy, vw, vh, cx, cy);
        this._drawDragon(ctx, ox, oy, vw, vh, cx, cy);
        this._drawInEyeHUD(ctx, ox, oy, vw, vh);
    }

    // === TRUE 3D PROJECTION ===
    _proj(x, y, z, vw, vh, cx, cy) {
        let rz = z - this.worldZ;
        if (rz <= 0.1) rz = 0.1;
        let s = 0.5 / rz;
        
        let cameraHeight = 0.7;    // Camera altitude
        let horizon = vh * 0.35;   // Horizon is high up (35% from top)
        
        return { 
            x: vw / 2 + x * s * vw + cx, 
            y: horizon + (cameraHeight - y) * s * vh + cy, 
            s 
        };
    }

    _drawSky(ctx, ox, oy, vw, vh, cy) {
        let g = ctx.createLinearGradient(ox, oy + cy * 0.5, ox, oy + vh);
        g.addColorStop(0, '#0b0d2a');
        g.addColorStop(0.15, '#141852');
        g.addColorStop(0.35, '#1e3a6e');
        g.addColorStop(0.55, '#2d6a9f');
        g.addColorStop(0.75, '#4a9ec4');
        g.addColorStop(0.9, '#7ecce5');
        g.addColorStop(1, '#aee8f5');
        ctx.fillStyle = g;
        ctx.fillRect(ox, oy, vw, vh);

        ctx.save();
        ctx.globalAlpha = 0.07;
        ctx.globalCompositeOperation = 'screen';
        for (let i = 0; i < 2; i++) {
            let ag = ctx.createLinearGradient(ox, oy + vh * 0.05, ox, oy + vh * 0.25);
            let hue = 160 + i * 50 + Math.sin(this.rainbowPhase + i * 2) * 30;
            ag.addColorStop(0, `hsla(${hue}, 90%, 65%, 0)`);
            ag.addColorStop(0.5, `hsla(${hue}, 90%, 65%, 0.7)`);
            ag.addColorStop(1, `hsla(${hue}, 90%, 65%, 0)`);
            ctx.fillStyle = ag;
            ctx.beginPath();
            ctx.moveTo(ox, oy + vh * 0.08);
            for (let x = 0; x <= vw; x += 15) {
                let y = vh * 0.12 + Math.sin(x / vw * 5 + this.rainbowPhase * (1 + i * 0.4)) * vh * 0.04;
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
        let t = performance.now() / 1000;
        for (let s of this.stars) {
            let p = this._proj(s.x, s.y + 1.2, this.worldZ + s.z, vw, vh, cx, cy);
            if (p.x < 0 || p.x > vw) continue;
            let tw = 0.4 + 0.6 * Math.sin(t * 2.5 + s.twinkle);
            ctx.fillStyle = `rgba(255,255,255,${tw * 0.7})`;
            ctx.beginPath();
            ctx.arc(ox + p.x, oy + p.y, Math.max(0.5, s.size * p.s * 3), 0, 6.28);
            ctx.fill();
        }
    }

    _drawSun(ctx, ox, oy, vw, vh, cx, cy) {
        let sunX = ox + vw * 0.7 + cx * 0.3;
        let sunY = oy + vh * 0.12 + cy * 0.2;
        let sunR = Math.min(vw, vh) * 0.06;

        for (let i = 3; i >= 0; i--) {
            let r = sunR * (1 + i * 0.8);
            let alpha = 0.04 - i * 0.008;
            ctx.fillStyle = `rgba(255, 200, 50, ${alpha})`;
            ctx.beginPath();
            ctx.arc(sunX, sunY, r, 0, 6.28);
            ctx.fill();
        }

        let sg = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, sunR);
        sg.addColorStop(0, '#fff8e1');
        sg.addColorStop(0.5, '#ffecb3');
        sg.addColorStop(1, 'rgba(255, 183, 77, 0.3)');
        ctx.fillStyle = sg;
        ctx.beginPath();
        ctx.arc(sunX, sunY, sunR, 0, 6.28);
        ctx.fill();
    }

    _drawGround(ctx, ox, oy, vw, vh, cx, cy) {
        let horizonY = vh * 0.35 + cy; // Match projection horizon
        let g = ctx.createLinearGradient(ox, oy + horizonY, ox, oy + vh);
        g.addColorStop(0, 'rgba(15, 45, 25, 0.4)');
        g.addColorStop(1, 'rgba(8, 25, 15, 0.9)');
        ctx.fillStyle = g;
        ctx.fillRect(ox, oy + horizonY, vw, vh - horizonY);
    }

    _drawMtns(ctx, ox, oy, vw, vh, cx, cy) {
        let sorted = [...this.mountains].sort((a, b) => b.z - a.z);
        for (let m of sorted) {
            let rz = m.z - this.worldZ;
            if (rz < 0.5 || rz > 25) continue;
            let p = this._proj(m.x, 0, m.z, vw, vh, cx, cy);
            let sw = m.w * p.s * vw;
            let sh = m.h * p.s * vh;
            let fog = Math.max(0, 1 - rz * 0.04);
            if (fog <= 0) continue;

            ctx.globalAlpha = fog;
            let mg = ctx.createLinearGradient(ox + p.x, oy + p.y - sh, ox + p.x, oy + p.y);
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
        for (let c of this.clouds) {
            let rz = c.z - this.worldZ;
            if (rz < 0.5 || rz > 20) continue;
            let p = this._proj(c.x, c.y + 1.2, c.z, vw, vh, cx, cy);
            let cw = c.w * p.s * vw;
            let ch = c.h * p.s * vh;
            let fog = Math.max(0, 1 - rz * 0.05);
            ctx.globalAlpha = c.op * fog;
            ctx.fillStyle = '#e8edf5';
            ctx.beginPath();
            ctx.ellipse(ox + p.x, oy + p.y, cw, ch, 0, 0, 6.28);
            ctx.fill();
            ctx.beginPath();
            ctx.ellipse(ox + p.x - cw * 0.4, oy + p.y + ch * 0.2, cw * 0.6, ch * 0.7, 0, 0, 6.28);
            ctx.fill();
            ctx.globalAlpha = 1;
        }
    }

    _drawRings(ctx, ox, oy, vw, vh, cx, cy) {
        let t = performance.now() / 1000;
        for (let r of this.rings) {
            if (r.passed) continue;
            let rz = r.z - this.worldZ;
            if (rz < 0 || rz > 18) continue;
            let p = this._proj(r.x, 0.3, r.z, vw, vh, cx, cy);
            let rs = r.size * p.s * vw;
            let fog = Math.max(0.2, 1 - rz * 0.03);

            ctx.globalAlpha = fog;
            ctx.strokeStyle = '#FFD700';
            ctx.lineWidth = Math.max(2, rs * 0.1);
            ctx.shadowBlur = rs * 0.5;
            ctx.shadowColor = '#FFD700';
            ctx.beginPath();
            ctx.ellipse(ox + p.x, oy + p.y, rs, rs * 0.6, 0, 0, 6.28);
            ctx.stroke();
            ctx.strokeStyle = '#FFA000';
            ctx.lineWidth = Math.max(1, rs * 0.05);
            ctx.beginPath();
            ctx.ellipse(ox + p.x, oy + p.y, rs * 0.85, rs * 0.5, 0, 0, 6.28);
            ctx.stroke();
            ctx.shadowBlur = 0;
            ctx.globalAlpha = 1;
        }
    }

    _drawObs(ctx, ox, oy, vw, vh, cx, cy) {
        let sorted = [...this.obstacles].sort((a, b) => b.z - a.z);
        for (let o of sorted) {
            let rz = o.z - this.worldZ;
            if (rz < -0.5 || rz > 20) continue;
            let p = this._proj(o.x, 0, o.z, vw, vh, cx, cy);
            let ow = o.w * p.s * vw;
            let oh = o.h * p.s * vh;
            let fog = Math.max(0.15, 1 - rz * 0.04);

            let rg = ctx.createLinearGradient(ox + p.x - ow, 0, ox + p.x + ow, 0);
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
                let u = Math.max(0, 1 - rz / 4);
                ctx.strokeStyle = `rgba(255, 50, 50, ${u * 0.6})`;
                ctx.lineWidth = 2;
                ctx.stroke();
            }
        }
    }

    _drawCrystals(ctx, ox, oy, vw, vh, cx, cy) {
        let t = performance.now() / 1000;
        for (let cr of this.crystals) {
            if (cr.collected) continue;
            let rz = cr.z - this.worldZ;
            if (rz < 0 || rz > 18) continue;
            let bobY = 0.3 + Math.sin(t * 3 + cr.phase) * 0.02;
            let p = this._proj(cr.x, bobY, cr.z, vw, vh, cx, cy);
            let cs = cr.size * p.s * vw;
            let fog = Math.max(0.2, 1 - rz * 0.035);

            ctx.globalAlpha = fog;
            ctx.shadowBlur = cs * 4;
            ctx.shadowColor = '#00f2fe';

            ctx.fillStyle = '#00e5ff';
            ctx.beginPath();
            ctx.moveTo(ox + p.x, oy + p.y - cs * 1.2);
            ctx.lineTo(ox + p.x + cs * 0.7, oy + p.y);
            ctx.lineTo(ox + p.x, oy + p.y + cs * 0.5);
            ctx.lineTo(ox + p.x - cs * 0.7, oy + p.y);
            ctx.closePath();
            ctx.fill();

            ctx.fillStyle = 'rgba(255,255,255,0.6)';
            ctx.beginPath();
            ctx.moveTo(ox + p.x, oy + p.y - cs * 0.8);
            ctx.lineTo(ox + p.x + cs * 0.3, oy + p.y - cs * 0.1);
            ctx.lineTo(ox + p.x - cs * 0.2, oy + p.y - cs * 0.2);
            ctx.closePath();
            ctx.fill();

            ctx.shadowBlur = 0;
            ctx.globalAlpha = 1;
        }
    }

    _drawParts(ctx, ox, oy, vw, vh, cx, cy) {
        for (let p of this.particles) {
            if (p.z !== undefined) {
                let pr = this._proj(p.x, p.y, p.z, vw, vh, cx, cy);
                let ps = p.size * pr.s * vw;
                ctx.globalAlpha = Math.max(0, p.life);
                ctx.fillStyle = p.color;
                if (p.type === 'line') {
                    ctx.fillRect(ox + pr.x - 1, oy + pr.y, 2, ps * 25);
                } else {
                    ctx.beginPath();
                    ctx.arc(ox + pr.x, oy + pr.y, Math.max(1, ps), 0, 6.28);
                    ctx.fill();
                }
            } else {
                ctx.globalAlpha = Math.max(0, p.life);
                ctx.fillStyle = p.color;
                ctx.beginPath();
                ctx.arc(ox + vw / 2 + p.x * vw * 0.3, oy + vh * 0.45 + p.y * vh * 0.2, p.size * vw, 0, 6.28);
                ctx.fill();
            }
        }
        ctx.globalAlpha = 1;
    }

    _drawDragon(ctx, ox, oy, vw, vh, cx, cy) {
        let dx = vw / 2 + this.dragonX * vw * 0.3 + cx;
        // Dragon is locked in the lower screen (75%)
        let dy = vh * 0.75 + cy; 
        let sc = Math.min(vw, vh) * 0.0018;
        if (sc < 0.5) sc = 0.5;

        if (this.hitCooldown > 0 && this.isAlive && Math.floor(performance.now() / 100) % 2 === 0) {
            ctx.globalAlpha = 0.4;
        }

        ctx.save();
        ctx.translate(ox + dx, oy + dy);
        ctx.rotate(this.dragonTilt * Math.PI / 180);
        ctx.scale(sc, sc);

        let wA = Math.sin(this.wingPhase) * 0.5;

        ctx.strokeStyle = '#2E7D32';
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(0, 30);
        ctx.quadraticCurveTo(-12 + Math.sin(this.wingPhase * 0.7) * 15, 60, -5 + Math.sin(this.wingPhase * 0.5) * 20, 80);
        ctx.stroke();
        ctx.fillStyle = '#FF6F00';
        let tx = -5 + Math.sin(this.wingPhase * 0.5) * 20;
        ctx.beginPath();
        ctx.moveTo(tx, 80); ctx.lineTo(tx - 8, 92); ctx.lineTo(tx + 8, 92);
        ctx.closePath(); ctx.fill();

        this._drawWing(ctx, -15, -5, -1, wA, sc);
        this._drawWing(ctx, 15, -5, 1, wA, sc);

        let bg = ctx.createLinearGradient(0, -30, 0, 35);
        bg.addColorStop(0, '#2E7D32');
        bg.addColorStop(0.5, '#43A047');
        bg.addColorStop(1, '#1B5E20');
        ctx.fillStyle = bg;
        ctx.beginPath(); ctx.ellipse(0, 10, 16, 30, 0, 0, 6.28); ctx.fill();

        ctx.fillStyle = '#A5D6A7';
        ctx.beginPath(); ctx.ellipse(0, 14, 10, 18, 0, 0, 6.28); ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.08)';
        ctx.lineWidth = 0.5;
        for (let i = -2; i <= 2; i++) { ctx.beginPath(); ctx.moveTo(-8, 10 + i * 6); ctx.lineTo(8, 10 + i * 6); ctx.stroke(); }

        ctx.fillStyle = '#2E7D32';
        ctx.beginPath(); ctx.ellipse(-12, 30, 5, 8, -0.3, 0, 6.28); ctx.fill();
        ctx.beginPath(); ctx.ellipse(12, 30, 5, 8, 0.3, 0, 6.28); ctx.fill();

        ctx.fillStyle = '#2E7D32';
        ctx.beginPath();
        ctx.moveTo(-8, -20); ctx.quadraticCurveTo(-4, -42, 0, -50);
        ctx.quadraticCurveTo(4, -42, 8, -20);
        ctx.closePath(); ctx.fill();

        let hg = ctx.createRadialGradient(0, -54, 0, 0, -54, 14);
        hg.addColorStop(0, '#43A047'); hg.addColorStop(1, '#2E7D32');
        ctx.fillStyle = hg;
        ctx.beginPath(); ctx.ellipse(0, -54, 14, 12, 0, 0, 6.28); ctx.fill();

        ctx.fillStyle = '#388E3C';
        ctx.beginPath(); ctx.ellipse(0, -65, 9, 6, 0, 0, 6.28); ctx.fill();
        ctx.fillStyle = '#1B5E20';
        ctx.beginPath(); ctx.arc(-3, -67, 1.5, 0, 6.28); ctx.fill();
        ctx.beginPath(); ctx.arc(3, -67, 1.5, 0, 6.28); ctx.fill();

        ctx.fillStyle = '#FFD600';
        ctx.beginPath(); ctx.ellipse(-7, -56, 4.5, 4, 0, 0, 6.28); ctx.fill();
        ctx.beginPath(); ctx.ellipse(7, -56, 4.5, 4, 0, 0, 6.28); ctx.fill();
        ctx.fillStyle = '#111';
        ctx.beginPath(); ctx.ellipse(-7, -56, 1.5, 3.2, 0, 0, 6.28); ctx.fill();
        ctx.beginPath(); ctx.ellipse(7, -56, 1.5, 3.2, 0, 0, 6.28); ctx.fill();
        ctx.shadowBlur = 10; ctx.shadowColor = '#FFD600';
        ctx.fillStyle = 'rgba(255,214,0,0.15)';
        ctx.beginPath(); ctx.arc(-7, -56, 7, 0, 6.28); ctx.fill();
        ctx.beginPath(); ctx.arc(7, -56, 7, 0, 6.28); ctx.fill();
        ctx.shadowBlur = 0;

        ctx.fillStyle = '#4E342E';
        ctx.beginPath(); ctx.moveTo(-11, -62); ctx.lineTo(-17, -76); ctx.lineTo(-8, -64); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.moveTo(11, -62); ctx.lineTo(17, -76); ctx.lineTo(8, -64); ctx.closePath(); ctx.fill();

        ctx.fillStyle = '#FF6F00';
        for (let i = 0; i < 5; i++) {
            let ry = -48 + i * 15, rs = 5 - i * 0.6;
            ctx.beginPath(); ctx.moveTo(0, ry - rs); ctx.lineTo(-rs * 0.7, ry + rs * 0.4); ctx.lineTo(rs * 0.7, ry + rs * 0.4); ctx.closePath(); ctx.fill();
        }

        if (this.speed > 1.3) {
            let fa = Math.min(1, (this.speed - 1.3) * 2);
            let fl = 18 + Math.random() * 12;
            ctx.globalAlpha = fa * 0.8;
            let fg = ctx.createLinearGradient(0, -70, 0, -70 - fl);
            fg.addColorStop(0, '#FF6F00'); fg.addColorStop(0.4, '#FF3D00'); fg.addColorStop(1, 'rgba(255,0,0,0)');
            ctx.fillStyle = fg;
            ctx.beginPath(); ctx.moveTo(-5, -70); ctx.lineTo(0, -70 - fl); ctx.lineTo(5, -70); ctx.closePath(); ctx.fill();
            ctx.globalAlpha = 1;
        }

        ctx.restore();
        ctx.globalAlpha = 1;
    }

    _drawWing(ctx, tx, ty, dir, wA, sc) {
        ctx.save();
        ctx.translate(tx, ty);
        ctx.rotate(dir * (-wA - 0.3));
        let sp = 85, wh = 28;
        let wg = ctx.createLinearGradient(0, 0, dir * sp, -wh);
        wg.addColorStop(0, '#388E3C'); wg.addColorStop(1, 'rgba(56, 142, 60, 0.3)');
        ctx.fillStyle = wg;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(dir * sp * 0.4, -wh * 1.6, dir * sp, -wh * 0.3);
        ctx.lineTo(dir * sp * 0.8, wh * 0.5);
        ctx.quadraticCurveTo(dir * sp * 0.3, wh * 0.3, 0, 10);
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.12)'; ctx.lineWidth = 1;
        for (let i = 1; i <= 3; i++) { ctx.beginPath(); ctx.moveTo(0, i * 2); ctx.lineTo(dir * sp * (i / 4), -wh * 0.15 + i * 5); ctx.stroke(); }
        ctx.restore();
    }

    _drawInEyeHUD(ctx, ox, oy, vw, vh) {
        let fs = Math.min(11, vw * 0.035);
        ctx.font = `bold ${fs}px 'Inter', sans-serif`;
        ctx.textAlign = 'center';

        let barW = vw * 0.85;
        let barX = ox + (vw - barW) / 2;
        let barY = oy + 8;

        ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
        if (ctx.roundRect) {
            ctx.beginPath(); ctx.roundRect(barX, barY, barW, fs + 10, 6); ctx.fill();
        } else {
            ctx.fillRect(barX, barY, barW, fs + 10);
        }

        let hearts = '❤️'.repeat(this.lives) + '🖤'.repeat(3 - this.lives);

        ctx.textAlign = 'left';
        ctx.fillStyle = '#FFD700';
        ctx.fillText(`⭐ ${Math.floor(this.score)}`, barX + 8, barY + fs + 3);

        ctx.textAlign = 'center';
        let comboStr = this.combo > 1 ? ` 🔥x${this.combo}` : '';
        ctx.fillStyle = '#00e5ff';
        ctx.fillText(`💎 ${this.crystalsCollected}${comboStr}`, ox + vw / 2, barY + fs + 3);

        ctx.textAlign = 'right';
        ctx.fillStyle = '#fff';
        ctx.fillText(hearts, barX + barW - 8, barY + fs + 3);

        let dist = Math.floor(this.distanceTraveled);
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.font = `${Math.min(9, vw * 0.025)}px 'Inter', sans-serif`;
        ctx.fillText(`${dist}м | ⚡x${this.speed.toFixed(1)}`, ox + vw / 2, oy + vh - 8);
    }

    stop() {
        this.particles = [];
        if (this._orientHandler) window.removeEventListener('deviceorientation', this._orientHandler);
    }
};
