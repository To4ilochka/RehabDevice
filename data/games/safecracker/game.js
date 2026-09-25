// ============================================================================
// 🔓 SafeCracker — Зламай Код | Гра на прецизійний контроль кисті
// RehabDevice IoT System | MPU6050/MPU6500 Sensor Control
// ============================================================================
// Тренує: точність позиціонування, утримання позиції (ізометрія),
//         повну амплітуду руху, плавність переходів між кутами.
// ============================================================================

window.RehabGames = window.RehabGames || {};

window.RehabGames['safecracker'] = class SafeCrackerGame {
    constructor(ctx, api) {
        this.ctx = ctx;
        this.api = api;

        // Calibration
        this.calibMin = -20;
        this.calibMax = 20;
        this.difficulty = 'auto';

        // Canvas
        this.width = ctx.canvas.width;
        this.height = ctx.canvas.height;

        // Game state
        this.score = 0;
        this.level = 1;
        this.safesOpened = 0;
        this.totalAttempts = 0;

        // Current safe puzzle
        this.combination = [];        // Array of target angles (normalized 0-1)
        this.currentStep = 0;         // Which combo step we're on
        this.comboLength = 2;         // How many steps per safe

        // Dial state
        this.dialAngle = 0.5;         // Current dial position (0-1)
        this.dialSmoothed = 0.5;      // Smoothed for rendering
        this.targetZoneMin = 0;       // Target zone bounds (0-1)
        this.targetZoneMax = 0;
        this.targetCenter = 0.5;
        this.zoneWidth = 0.12;        // Width of the target zone (decreases with difficulty)

        // Hold mechanic
        this.holdProgress = 0;        // 0-1, fills when holding in zone
        this.holdRequired = 2.0;      // Seconds to hold (increases with difficulty)
        this.isInZone = false;
        this.wasInZone = false;

        // Vault door animation
        this.doorOpenProgress = 0;    // 0-1 for door swing animation
        this.doorState = 'locked';    // 'locked', 'unlocking', 'open', 'nextSafe'
        this.stateTimer = 0;

        // Visual effects
        this.sparks = [];
        this.glowPulse = 0;
        this.shakeIntensity = 0;
        this.successFlash = 0;
        this.lockTumblers = [];       // Visual tumblers falling into place
        this.backgroundHue = 220;

        // Dial tick marks
        this.dialTicks = [];
        this._generateDialTicks();

        // Stars / reward particles
        this.rewardParticles = [];

        // Streak tracking
        this.perfectStreak = 0;       // Opens without leaving zone
        this.bestStreak = 0;

        // Timer for current safe
        this.safeTimer = 0;
        this.safeBestTime = Infinity;

        // Arrow hint animation
        this.arrowBlink = 0;
    }

    init(calibMin, calibMax, difficulty) {
        this.calibMin = calibMin;
        this.calibMax = calibMax;
        this.difficulty = difficulty || 'auto';

        this.resize(this.ctx.canvas.width, this.ctx.canvas.height);
        this.score = 0;
        this.level = 1;
        this.safesOpened = 0;
        this.totalAttempts = 0;
        this.perfectStreak = 0;
        this.bestStreak = 0;
        this.safeBestTime = Infinity;

        this._setDifficultyParams();
        this._generateNewSafe();
        this._updateHUD();
    }

    resize(width, height) {
        this.width = width;
        this.height = height;
    }

    // ========================================================================
    // DIFFICULTY
    // ========================================================================
    _setDifficultyParams() {
        switch (this.difficulty) {
            case 'easy':
                this.zoneWidth = 0.16;
                this.holdRequired = 1.5;
                this.comboLength = 2;
                break;
            case 'medium':
                this.zoneWidth = 0.10;
                this.holdRequired = 2.0;
                this.comboLength = 3;
                break;
            case 'hard':
                this.zoneWidth = 0.06;
                this.holdRequired = 2.5;
                this.comboLength = 4;
                break;
            case 'auto':
            default:
                this.zoneWidth = 0.15;
                this.holdRequired = 1.5;
                this.comboLength = 2;
                break;
        }
    }

    _adaptDifficulty() {
        if (this.difficulty !== 'auto') return;

        // Progressively harder with each safe opened
        let progress = Math.min(1, this.safesOpened / 20);
        this.zoneWidth = 0.15 - progress * 0.08;     // 0.15 → 0.07
        this.holdRequired = 1.5 + progress * 1.5;     // 1.5s → 3.0s
        this.comboLength = Math.min(5, 2 + Math.floor(this.safesOpened / 4));

        // Level display
        this.level = Math.min(10, 1 + Math.floor(this.safesOpened / 2));
    }

    // ========================================================================
    // SAFE GENERATION
    // ========================================================================
    _generateNewSafe() {
        this.combination = [];
        this.currentStep = 0;
        this.holdProgress = 0;
        this.isInZone = false;
        this.doorState = 'locked';
        this.doorOpenProgress = 0;
        this.stateTimer = 0;
        this.safeTimer = 0;
        this.lockTumblers = [];

        // Generate combo steps — spread targets across the full range
        // This encourages using the full range of wrist motion
        let usedPositions = [];
        for (let i = 0; i < this.comboLength; i++) {
            let pos;
            let attempts = 0;
            do {
                // Bias towards edges to encourage full range of motion
                let r = Math.random();
                if (r < 0.3) {
                    pos = 0.1 + Math.random() * 0.2;   // Left zone (10-30%)
                } else if (r < 0.6) {
                    pos = 0.7 + Math.random() * 0.2;   // Right zone (70-90%)
                } else {
                    pos = 0.2 + Math.random() * 0.6;   // Full range (20-80%)
                }
                attempts++;
            } while (usedPositions.some(p => Math.abs(p - pos) < 0.15) && attempts < 20);

            usedPositions.push(pos);
            this.combination.push(pos);
        }

        // Generate tumbler visuals
        for (let i = 0; i < this.comboLength; i++) {
            this.lockTumblers.push({
                unlocked: false,
                bounceY: 0,
                bounceVel: 0
            });
        }

        this._updateTargetZone();
    }

    _updateTargetZone() {
        if (this.currentStep < this.combination.length) {
            this.targetCenter = this.combination[this.currentStep];
            this.targetZoneMin = this.targetCenter - this.zoneWidth / 2;
            this.targetZoneMax = this.targetCenter + this.zoneWidth / 2;
        }
    }

    _generateDialTicks() {
        this.dialTicks = [];
        for (let i = 0; i <= 100; i++) {
            this.dialTicks.push({
                pos: i / 100,
                major: i % 10 === 0,
                label: i % 10 === 0 ? i.toString() : null
            });
        }
    }

    // ========================================================================
    // MAIN UPDATE
    // ========================================================================
    update(dt, currentAngle) {
        if (dt > 0.1) dt = 0.016;

        // Dynamic calibration expansion
        let boundsChanged = false;
        if (currentAngle > this.calibMax) {
            this.calibMax += (currentAngle - this.calibMax) * 0.05;
            boundsChanged = true;
        }
        if (currentAngle < this.calibMin) {
            this.calibMin -= (this.calibMin - currentAngle) * 0.05;
            boundsChanged = true;
        }
        if (boundsChanged) this.api.updateCalibration(this.calibMin, this.calibMax);

        // Map angle to dial position (0-1)
        let range = this.calibMax - this.calibMin;
        if (range > 0) {
            this.dialAngle = (currentAngle - this.calibMin) / range;
        } else {
            this.dialAngle = 0.5;
        }
        this.dialAngle = Math.max(0, Math.min(1, this.dialAngle));

        // Smooth dial for visuals
        this.dialSmoothed += (this.dialAngle - this.dialSmoothed) * 12 * dt;

        // Visual updates
        this.glowPulse += dt * 3;
        this.arrowBlink += dt * 4;
        this.shakeIntensity *= Math.pow(0.02, dt);
        if (this.shakeIntensity < 0.3) this.shakeIntensity = 0;
        this.successFlash = Math.max(0, this.successFlash - dt * 3);

        // Update particles
        this._updateParticles(dt);

        // Update tumbler animations
        for (let t of this.lockTumblers) {
            if (t.unlocked) {
                t.bounceVel += 600 * dt;
                t.bounceY += t.bounceVel * dt;
                if (t.bounceY > 0) {
                    t.bounceY = 0;
                    t.bounceVel = -t.bounceVel * 0.4;
                    if (Math.abs(t.bounceVel) < 10) t.bounceVel = 0;
                }
            }
        }

        // === STATE MACHINE ===
        switch (this.doorState) {
            case 'locked':
                this._updateLocked(dt);
                break;
            case 'unlocking':
                this._updateUnlocking(dt);
                break;
            case 'open':
                this._updateOpen(dt);
                break;
            case 'nextSafe':
                this._updateNextSafe(dt);
                break;
        }

        this._updateHUD();
    }

    // ---- STATE: LOCKED (player working on combination) ----
    _updateLocked(dt) {
        this.safeTimer += dt;

        // Check if dial is in target zone
        this.wasInZone = this.isInZone;
        this.isInZone = this.dialAngle >= this.targetZoneMin && this.dialAngle <= this.targetZoneMax;

        if (this.isInZone) {
            // Filling hold progress
            this.holdProgress += dt / this.holdRequired;

            // Spawn sparks while holding
            if (Math.random() < 0.3) {
                this._spawnHoldSpark();
            }

            if (this.holdProgress >= 1) {
                // Step completed!
                this.holdProgress = 0;

                // Unlock this tumbler
                if (this.lockTumblers[this.currentStep]) {
                    this.lockTumblers[this.currentStep].unlocked = true;
                    this.lockTumblers[this.currentStep].bounceVel = -300;
                }

                this.currentStep++;
                this.shakeIntensity = 5;
                this._spawnStepCompleteParticles();

                if (this.currentStep >= this.combination.length) {
                    // All steps done! Safe cracked!
                    this.doorState = 'unlocking';
                    this.stateTimer = 0;
                    this.totalAttempts++;
                } else {
                    // Next step
                    this._updateTargetZone();
                }
            }
        } else {
            // Slowly decay hold progress when outside zone
            this.holdProgress = Math.max(0, this.holdProgress - dt * 0.8);

            // Track if patient left zone (breaks perfect streak)
            if (this.wasInZone && this.holdProgress > 0.1) {
                this.perfectStreak = 0;
            }
        }
    }

    // ---- STATE: UNLOCKING (door animation) ----
    _updateUnlocking(dt) {
        this.stateTimer += dt;
        this.doorOpenProgress += dt * 0.8;

        if (this.doorOpenProgress >= 1) {
            this.doorOpenProgress = 1;
            this.doorState = 'open';
            this.stateTimer = 0;

            // Score!
            this.safesOpened++;
            this.perfectStreak++;
            if (this.perfectStreak > this.bestStreak) {
                this.bestStreak = this.perfectStreak;
            }

            let timeBonus = Math.max(0, Math.floor(30 - this.safeTimer));
            let streakBonus = this.perfectStreak * 5;
            this.score += 100 + timeBonus + streakBonus;

            if (this.safeTimer < this.safeBestTime) {
                this.safeBestTime = this.safeTimer;
            }

            // Success effects
            this.successFlash = 1;
            this.shakeIntensity = 8;
            this._spawnRewardParticles();
            this._adaptDifficulty();

            // Shift background hue for variety
            this.backgroundHue = (this.backgroundHue + 30) % 360;
        }
    }

    // ---- STATE: OPEN (showing reward) ----
    _updateOpen(dt) {
        this.stateTimer += dt;
        if (this.stateTimer > 2.5) {
            this.doorState = 'nextSafe';
            this.stateTimer = 0;
        }
    }

    // ---- STATE: NEXT SAFE (transition) ----
    _updateNextSafe(dt) {
        this.stateTimer += dt;
        if (this.stateTimer > 0.8) {
            this._generateNewSafe();
        }
    }

    // ========================================================================
    // PARTICLES
    // ========================================================================
    _spawnHoldSpark() {
        let cx = this.width / 2;
        let cy = this.height * 0.45;
        let dialR = Math.min(this.width, this.height) * 0.28;
        let angle = this.dialSmoothed * Math.PI * 1.5 - Math.PI * 0.75;
        let sx = cx + Math.cos(angle) * dialR * 0.85;
        let sy = cy + Math.sin(angle) * dialR * 0.85;

        this.sparks.push({
            x: sx + (Math.random() - 0.5) * 10,
            y: sy + (Math.random() - 0.5) * 10,
            vx: (Math.random() - 0.5) * 40,
            vy: -20 - Math.random() * 40,
            life: 1,
            maxLife: 0.6 + Math.random() * 0.4,
            size: 1.5 + Math.random() * 2,
            color: '#00f2fe',
            type: 'spark'
        });
    }

    _spawnStepCompleteParticles() {
        let cx = this.width / 2;
        let cy = this.height * 0.45;
        for (let i = 0; i < 20; i++) {
            let a = Math.random() * Math.PI * 2;
            let spd = 60 + Math.random() * 120;
            this.sparks.push({
                x: cx, y: cy,
                vx: Math.cos(a) * spd,
                vy: Math.sin(a) * spd,
                life: 1, maxLife: 1,
                size: 2 + Math.random() * 3,
                color: i % 2 === 0 ? '#00e676' : '#00f2fe',
                type: 'burst'
            });
        }
    }

    _spawnRewardParticles() {
        let cx = this.width / 2;
        let cy = this.height * 0.4;
        for (let i = 0; i < 40; i++) {
            let a = Math.random() * Math.PI * 2;
            let spd = 80 + Math.random() * 200;
            let colors = ['#FFD700', '#FFA000', '#FFEB3B', '#FF6F00', '#00f2fe'];
            this.rewardParticles.push({
                x: cx + (Math.random() - 0.5) * 60,
                y: cy + (Math.random() - 0.5) * 60,
                vx: Math.cos(a) * spd,
                vy: Math.sin(a) * spd - 80,
                life: 1, maxLife: 1.5 + Math.random() * 0.5,
                size: 3 + Math.random() * 5,
                color: colors[Math.floor(Math.random() * colors.length)],
                gravity: 150,
                rotation: Math.random() * Math.PI * 2,
                rotSpeed: (Math.random() - 0.5) * 8
            });
        }
    }

    _updateParticles(dt) {
        for (let i = this.sparks.length - 1; i >= 0; i--) {
            let p = this.sparks[i];
            p.life -= dt / p.maxLife;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            if (p.life <= 0) this.sparks.splice(i, 1);
        }
        for (let i = this.rewardParticles.length - 1; i >= 0; i--) {
            let p = this.rewardParticles[i];
            p.life -= dt / p.maxLife;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.vy += (p.gravity || 0) * dt;
            p.rotation += (p.rotSpeed || 0) * dt;
            if (p.life <= 0) this.rewardParticles.splice(i, 1);
        }
    }

    // ========================================================================
    // HUD
    // ========================================================================
    _updateHUD() {
        let stepText = this.doorState === 'locked'
            ? `Крок ${this.currentStep + 1}/${this.combination.length}`
            : this.doorState === 'open' ? '🎉 Відкрито!' : '...';
        let streakText = this.perfectStreak > 1 ? ` | 🔥 Серія: ${this.perfectStreak}` : '';
        this.api.updateHUD("hudScore", `🔓 Сейф #${this.safesOpened + 1} | Очки: ${this.score}${streakText}`);
        this.api.updateHUD("hudBotState", `${stepText} | Рівень: ${this.level}/10`);
    }

    // ========================================================================
    // MAIN DRAW
    // ========================================================================
    draw() {
        const ctx = this.ctx;
        const W = this.width;
        const H = this.height;

        ctx.save();

        // Screen shake
        if (this.shakeIntensity > 0) {
            ctx.translate(
                (Math.random() - 0.5) * this.shakeIntensity,
                (Math.random() - 0.5) * this.shakeIntensity
            );
        }

        // === BACKGROUND ===
        this._drawBackground(ctx, W, H);

        // === SAFE BODY ===
        this._drawSafeBody(ctx, W, H);

        // === COMBINATION INDICATOR (top) ===
        this._drawCombinationSteps(ctx, W, H);

        // === DIAL ===
        this._drawDial(ctx, W, H);

        // === TARGET ZONE ARROW HINT ===
        if (this.doorState === 'locked') {
            this._drawTargetHint(ctx, W, H);
        }

        // === HOLD PROGRESS BAR ===
        if (this.doorState === 'locked') {
            this._drawHoldBar(ctx, W, H);
        }

        // === DOOR ANIMATION ===
        if (this.doorState === 'unlocking' || this.doorState === 'open') {
            this._drawDoorOpen(ctx, W, H);
        }

        // === SPARKS & PARTICLES ===
        this._drawSparks(ctx);
        this._drawRewardParticles(ctx);

        // === SUCCESS FLASH ===
        if (this.successFlash > 0) {
            ctx.fillStyle = `rgba(0, 230, 118, ${this.successFlash * 0.15})`;
            ctx.fillRect(0, 0, W, H);
        }

        // === TRANSITION OVERLAY ===
        if (this.doorState === 'nextSafe') {
            let alpha = Math.min(1, this.stateTimer / 0.4);
            ctx.fillStyle = `rgba(10, 14, 23, ${alpha * 0.8})`;
            ctx.fillRect(0, 0, W, H);

            let titleSize = Math.min(36, W * 0.06);
            ctx.font = `bold ${titleSize}px 'Inter', sans-serif`;
            ctx.textAlign = 'center';
            ctx.fillStyle = `rgba(0, 242, 254, ${alpha})`;
            ctx.fillText(`🔐 Сейф #${this.safesOpened + 1}`, W / 2, H * 0.45);

            let subSize = Math.min(18, W * 0.03);
            ctx.font = `${subSize}px 'Inter', sans-serif`;
            ctx.fillStyle = `rgba(148, 163, 184, ${alpha})`;
            ctx.fillText(`Кроків: ${this.comboLength} | Зона: ${Math.round(this.zoneWidth * 100)}%`, W / 2, H * 0.53);
        }

        ctx.restore();
    }

    // ========================================================================
    // BACKGROUND
    // ========================================================================
    _drawBackground(ctx, W, H) {
        // Dark vault room gradient
        let grad = ctx.createRadialGradient(W / 2, H * 0.4, 0, W / 2, H * 0.4, Math.max(W, H) * 0.8);
        let hue = this.backgroundHue;
        grad.addColorStop(0, `hsl(${hue}, 30%, 12%)`);
        grad.addColorStop(0.5, `hsl(${hue}, 25%, 8%)`);
        grad.addColorStop(1, `hsl(${hue}, 20%, 4%)`);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, H);

        // Subtle grid pattern
        ctx.strokeStyle = `hsla(${hue}, 20%, 20%, 0.08)`;
        ctx.lineWidth = 1;
        let gridSize = 40;
        for (let x = 0; x < W; x += gridSize) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, H);
            ctx.stroke();
        }
        for (let y = 0; y < H; y += gridSize) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(W, y);
            ctx.stroke();
        }

        // Ambient light glow behind the safe
        ctx.save();
        ctx.globalAlpha = 0.06;
        let ambientGrad = ctx.createRadialGradient(W / 2, H * 0.45, 0, W / 2, H * 0.45, Math.min(W, H) * 0.5);
        ambientGrad.addColorStop(0, '#00f2fe');
        ambientGrad.addColorStop(1, 'transparent');
        ctx.fillStyle = ambientGrad;
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
    }

    // ========================================================================
    // SAFE BODY
    // ========================================================================
    _drawSafeBody(ctx, W, H) {
        let safeW = Math.min(W * 0.7, 400);
        let safeH = Math.min(H * 0.55, 350);
        let safeX = (W - safeW) / 2;
        let safeY = H * 0.22;

        // Safe shadow
        ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
        ctx.fillRect(safeX + 6, safeY + 6, safeW, safeH);

        // Main safe body
        let bodyGrad = ctx.createLinearGradient(safeX, safeY, safeX, safeY + safeH);
        bodyGrad.addColorStop(0, '#37474F');
        bodyGrad.addColorStop(0.3, '#455A64');
        bodyGrad.addColorStop(0.7, '#37474F');
        bodyGrad.addColorStop(1, '#263238');
        ctx.fillStyle = bodyGrad;

        if (ctx.roundRect) {
            ctx.beginPath();
            ctx.roundRect(safeX, safeY, safeW, safeH, 8);
            ctx.fill();
        } else {
            ctx.fillRect(safeX, safeY, safeW, safeH);
        }

        // Border
        ctx.strokeStyle = '#546E7A';
        ctx.lineWidth = 3;
        if (ctx.roundRect) {
            ctx.beginPath();
            ctx.roundRect(safeX, safeY, safeW, safeH, 8);
            ctx.stroke();
        }

        // Bolts (corners)
        let boltPositions = [
            [safeX + 15, safeY + 15],
            [safeX + safeW - 15, safeY + 15],
            [safeX + 15, safeY + safeH - 15],
            [safeX + safeW - 15, safeY + safeH - 15]
        ];
        for (let [bx, by] of boltPositions) {
            ctx.fillStyle = '#78909C';
            ctx.beginPath();
            ctx.arc(bx, by, 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#546E7A';
            ctx.beginPath();
            ctx.arc(bx, by, 2.5, 0, Math.PI * 2);
            ctx.fill();
        }

        // Handle (right side)
        let handleX = safeX + safeW - 35;
        let handleY = safeY + safeH * 0.5;

        ctx.fillStyle = '#90A4AE';
        ctx.fillRect(handleX, handleY - 25, 12, 50);
        ctx.fillStyle = '#B0BEC5';
        ctx.beginPath();
        ctx.arc(handleX + 6, handleY - 25, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(handleX + 6, handleY + 25, 8, 0, Math.PI * 2);
        ctx.fill();

        // Brand plate
        let plateW = safeW * 0.35;
        let plateH = 22;
        let plateX = (W - plateW) / 2;
        let plateY = safeY + 12;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
        if (ctx.roundRect) {
            ctx.beginPath();
            ctx.roundRect(plateX, plateY, plateW, plateH, 4);
            ctx.fill();
        }
        ctx.font = `bold ${Math.min(12, W * 0.025)}px 'Inter', monospace`;
        ctx.textAlign = 'center';
        ctx.fillStyle = '#78909C';
        ctx.fillText(`REHAB-SAFE™ Lvl.${this.level}`, W / 2, plateY + 15);

        // Lock tumblers display
        this._drawTumblers(ctx, W, safeX, safeY, safeW, safeH);
    }

    // ========================================================================
    // TUMBLERS
    // ========================================================================
    _drawTumblers(ctx, W, safeX, safeY, safeW, safeH) {
        let tumblersY = safeY + safeH - 40;
        let totalW = this.comboLength * 30 + (this.comboLength - 1) * 10;
        let startX = (W - totalW) / 2;

        for (let i = 0; i < this.comboLength; i++) {
            let tx = startX + i * 40 + 15;
            let ty = tumblersY + (this.lockTumblers[i] ? this.lockTumblers[i].bounceY : 0);
            let unlocked = this.lockTumblers[i] && this.lockTumblers[i].unlocked;

            // Tumbler slot
            ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
            ctx.fillRect(tx - 10, tumblersY - 12, 20, 24);

            // Tumbler pin
            ctx.fillStyle = unlocked ? '#00e676' : (i === this.currentStep && this.doorState === 'locked' ? '#ff9100' : '#546E7A');
            if (ctx.roundRect) {
                ctx.beginPath();
                ctx.roundRect(tx - 8, ty - 10, 16, 20, 3);
                ctx.fill();
            } else {
                ctx.fillRect(tx - 8, ty - 10, 16, 20);
            }

            // Glow for active tumbler
            if (i === this.currentStep && this.doorState === 'locked') {
                ctx.shadowBlur = 8;
                ctx.shadowColor = '#ff9100';
                ctx.fillStyle = 'rgba(255, 145, 0, 0.3)';
                ctx.beginPath();
                ctx.arc(tx, ty, 14, 0, Math.PI * 2);
                ctx.fill();
                ctx.shadowBlur = 0;
            }
        }
    }

    // ========================================================================
    // COMBINATION STEPS DISPLAY
    // ========================================================================
    _drawCombinationSteps(ctx, W, H) {
        let y = H * 0.13;
        let dotR = Math.min(12, W * 0.02);
        let gap = dotR * 3.5;
        let totalW = this.comboLength * gap;
        let startX = (W - totalW) / 2 + gap / 2;

        for (let i = 0; i < this.comboLength; i++) {
            let x = startX + i * gap;
            let completed = i < this.currentStep;
            let active = i === this.currentStep && this.doorState === 'locked';

            // Outer ring
            ctx.strokeStyle = completed ? '#00e676' : (active ? '#ff9100' : 'rgba(255,255,255,0.2)');
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(x, y, dotR, 0, Math.PI * 2);
            ctx.stroke();

            // Fill
            if (completed) {
                ctx.fillStyle = '#00e676';
                ctx.beginPath();
                ctx.arc(x, y, dotR - 2, 0, Math.PI * 2);
                ctx.fill();

                // Checkmark
                ctx.strokeStyle = '#0a0e17';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(x - 4, y);
                ctx.lineTo(x - 1, y + 3);
                ctx.lineTo(x + 5, y - 4);
                ctx.stroke();
            } else if (active) {
                // Pulsing fill
                let pulse = 0.4 + 0.3 * Math.sin(this.glowPulse);
                ctx.fillStyle = `rgba(255, 145, 0, ${pulse})`;
                ctx.beginPath();
                ctx.arc(x, y, dotR - 2, 0, Math.PI * 2);
                ctx.fill();

                // Step number
                ctx.font = `bold ${dotR}px 'Inter', sans-serif`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillStyle = '#ffffff';
                ctx.fillText((i + 1).toString(), x, y + 1);
            } else {
                ctx.fillStyle = 'rgba(255,255,255,0.08)';
                ctx.beginPath();
                ctx.arc(x, y, dotR - 2, 0, Math.PI * 2);
                ctx.fill();

                ctx.font = `${dotR * 0.8}px 'Inter', sans-serif`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillStyle = 'rgba(255,255,255,0.3)';
                ctx.fillText((i + 1).toString(), x, y + 1);
            }
        }

        ctx.textBaseline = 'alphabetic';
    }

    // ========================================================================
    // DIAL
    // ========================================================================
    _drawDial(ctx, W, H) {
        let cx = W / 2;
        let cy = H * 0.5;
        let radius = Math.min(W, H) * 0.22;

        // Dial background (dark circle)
        ctx.fillStyle = '#1a1a2e';
        ctx.beginPath();
        ctx.arc(cx, cy, radius + 8, 0, Math.PI * 2);
        ctx.fill();

        // Outer ring
        let ringGrad = ctx.createLinearGradient(cx - radius, cy - radius, cx + radius, cy + radius);
        ringGrad.addColorStop(0, '#546E7A');
        ringGrad.addColorStop(0.5, '#78909C');
        ringGrad.addColorStop(1, '#455A64');
        ctx.strokeStyle = ringGrad;
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.arc(cx, cy, radius + 4, 0, Math.PI * 2);
        ctx.stroke();

        // Inner dial face
        let faceGrad = ctx.createRadialGradient(cx, cy - radius * 0.3, 0, cx, cy, radius);
        faceGrad.addColorStop(0, '#2a2a3e');
        faceGrad.addColorStop(1, '#16162a');
        ctx.fillStyle = faceGrad;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fill();

        // Arc range: from -135° to +135° (270° sweep)
        let arcStart = -Math.PI * 0.75;
        let arcEnd = Math.PI * 0.75;
        let arcRange = arcEnd - arcStart;

        // Target zone arc
        if (this.doorState === 'locked') {
            let tzStart = arcStart + this.targetZoneMin * arcRange;
            let tzEnd = arcStart + this.targetZoneMax * arcRange;

            // Zone glow
            ctx.save();
            ctx.shadowBlur = 15;
            ctx.shadowColor = this.isInZone ? '#00e676' : '#ff9100';
            ctx.strokeStyle = this.isInZone
                ? `rgba(0, 230, 118, ${0.6 + 0.3 * Math.sin(this.glowPulse)})`
                : `rgba(255, 145, 0, ${0.4 + 0.2 * Math.sin(this.glowPulse)})`;
            ctx.lineWidth = 12;
            ctx.beginPath();
            ctx.arc(cx, cy, radius - 10, tzStart - Math.PI / 2, tzEnd - Math.PI / 2);
            ctx.stroke();
            ctx.shadowBlur = 0;
            ctx.restore();

            // Zone fill
            ctx.fillStyle = this.isInZone
                ? 'rgba(0, 230, 118, 0.08)'
                : 'rgba(255, 145, 0, 0.05)';
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.arc(cx, cy, radius - 4, tzStart - Math.PI / 2, tzEnd - Math.PI / 2);
            ctx.closePath();
            ctx.fill();
        }

        // Tick marks
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (let t of this.dialTicks) {
            let angle = arcStart + t.pos * arcRange - Math.PI / 2;
            let innerR = t.major ? radius - 25 : radius - 15;
            let outerR = radius - 5;

            ctx.strokeStyle = t.major ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.15)';
            ctx.lineWidth = t.major ? 2 : 1;
            ctx.beginPath();
            ctx.moveTo(cx + Math.cos(angle) * innerR, cy + Math.sin(angle) * innerR);
            ctx.lineTo(cx + Math.cos(angle) * outerR, cy + Math.sin(angle) * outerR);
            ctx.stroke();

            if (t.label) {
                let labelR = radius - 35;
                ctx.font = `${Math.min(10, W * 0.018)}px 'Inter', sans-serif`;
                ctx.fillStyle = 'rgba(255,255,255,0.4)';
                ctx.fillText(t.label, cx + Math.cos(angle) * labelR, cy + Math.sin(angle) * labelR);
            }
        }

        // Dial needle (player position)
        let needleAngle = arcStart + this.dialSmoothed * arcRange - Math.PI / 2;
        let needleLen = radius - 15;

        // Needle shadow
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(cx + 2, cy + 2);
        ctx.lineTo(cx + Math.cos(needleAngle) * needleLen + 2, cy + Math.sin(needleAngle) * needleLen + 2);
        ctx.stroke();

        // Needle
        let needleColor = this.isInZone ? '#00e676' : '#ff1744';
        ctx.strokeStyle = needleColor;
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(needleAngle) * needleLen, cy + Math.sin(needleAngle) * needleLen);
        ctx.stroke();
        ctx.lineCap = 'butt';

        // Needle glow
        ctx.save();
        ctx.shadowBlur = 10;
        ctx.shadowColor = needleColor;
        ctx.strokeStyle = needleColor;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(needleAngle) * needleLen, cy + Math.sin(needleAngle) * needleLen);
        ctx.stroke();
        ctx.restore();

        // Needle tip dot
        ctx.fillStyle = needleColor;
        ctx.beginPath();
        ctx.arc(
            cx + Math.cos(needleAngle) * needleLen,
            cy + Math.sin(needleAngle) * needleLen,
            4, 0, Math.PI * 2
        );
        ctx.fill();

        // Center hub
        let hubGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 12);
        hubGrad.addColorStop(0, '#90A4AE');
        hubGrad.addColorStop(1, '#546E7A');
        ctx.fillStyle = hubGrad;
        ctx.beginPath();
        ctx.arc(cx, cy, 10, 0, Math.PI * 2);
        ctx.fill();

        // Hub inner dot
        ctx.fillStyle = '#263238';
        ctx.beginPath();
        ctx.arc(cx, cy, 4, 0, Math.PI * 2);
        ctx.fill();
    }

    // ========================================================================
    // TARGET HINT ARROW
    // ========================================================================
    _drawTargetHint(ctx, W, H) {
        let cx = W / 2;
        let cy = H * 0.5;
        let radius = Math.min(W, H) * 0.22;

        let arcStart = -Math.PI * 0.75;
        let arcRange = Math.PI * 1.5;
        let targetAngle = arcStart + this.targetCenter * arcRange - Math.PI / 2;

        let arrowDist = radius + 25;
        let ax = cx + Math.cos(targetAngle) * arrowDist;
        let ay = cy + Math.sin(targetAngle) * arrowDist;

        let blinkAlpha = 0.4 + 0.4 * Math.sin(this.arrowBlink);

        // Direction text
        let direction = this.targetCenter < this.dialSmoothed ? '◀' : this.targetCenter > this.dialSmoothed ? '▶' : '●';
        if (Math.abs(this.targetCenter - this.dialSmoothed) < this.zoneWidth / 2) direction = '●';

        ctx.font = `bold ${Math.min(16, W * 0.03)}px 'Inter', sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillStyle = `rgba(255, 145, 0, ${blinkAlpha})`;
        ctx.fillText(direction, ax, ay);
    }

    // ========================================================================
    // HOLD PROGRESS BAR
    // ========================================================================
    _drawHoldBar(ctx, W, H) {
        let barW = Math.min(W * 0.5, 250);
        let barH = 14;
        let barX = (W - barW) / 2;
        let barY = H * 0.78;

        // Label
        ctx.font = `${Math.min(12, W * 0.022)}px 'Inter', sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillStyle = this.isInZone ? '#00e676' : '#94a3b8';
        let holdText = this.isInZone ? '🔒 Утримуйте...' : '🎯 Наведіть на зону';
        ctx.fillText(holdText, W / 2, barY - 8);

        // Bar background
        ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
        if (ctx.roundRect) {
            ctx.beginPath();
            ctx.roundRect(barX, barY, barW, barH, 7);
            ctx.fill();
        } else {
            ctx.fillRect(barX, barY, barW, barH);
        }

        // Bar fill
        if (this.holdProgress > 0) {
            let fillW = barW * Math.min(1, this.holdProgress);
            let fillGrad = ctx.createLinearGradient(barX, 0, barX + fillW, 0);

            if (this.holdProgress > 0.8) {
                fillGrad.addColorStop(0, '#00e676');
                fillGrad.addColorStop(1, '#69f0ae');
            } else if (this.isInZone) {
                fillGrad.addColorStop(0, '#00f2fe');
                fillGrad.addColorStop(1, '#4facfe');
            } else {
                fillGrad.addColorStop(0, '#ff9100');
                fillGrad.addColorStop(1, '#ffab40');
            }

            ctx.fillStyle = fillGrad;
            if (ctx.roundRect) {
                ctx.beginPath();
                ctx.roundRect(barX, barY, fillW, barH, 7);
                ctx.fill();
            } else {
                ctx.fillRect(barX, barY, fillW, barH);
            }

            // Glow
            ctx.save();
            ctx.shadowBlur = 8;
            ctx.shadowColor = this.holdProgress > 0.8 ? '#00e676' : '#00f2fe';
            ctx.fillStyle = 'transparent';
            if (ctx.roundRect) {
                ctx.beginPath();
                ctx.roundRect(barX, barY, fillW, barH, 7);
                ctx.fill();
            }
            ctx.restore();
        }

        // Percentage text
        ctx.font = `bold ${Math.min(10, W * 0.018)}px 'Inter', monospace`;
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.fillText(`${Math.floor(this.holdProgress * 100)}%`, W / 2, barY + barH + 14);
    }

    // ========================================================================
    // DOOR OPEN ANIMATION
    // ========================================================================
    _drawDoorOpen(ctx, W, H) {
        // Glowing light from inside the safe
        let lightAlpha = this.doorOpenProgress * 0.6;
        let safeW = Math.min(W * 0.7, 400);
        let safeX = (W - safeW) / 2;
        let safeY = H * 0.22;
        let safeH = Math.min(H * 0.55, 350);

        let innerGrad = ctx.createRadialGradient(
            W / 2, safeY + safeH / 2, 0,
            W / 2, safeY + safeH / 2, safeW * 0.4
        );
        innerGrad.addColorStop(0, `rgba(255, 215, 0, ${lightAlpha})`);
        innerGrad.addColorStop(0.5, `rgba(255, 165, 0, ${lightAlpha * 0.5})`);
        innerGrad.addColorStop(1, `rgba(255, 165, 0, 0)`);
        ctx.fillStyle = innerGrad;
        ctx.fillRect(safeX, safeY, safeW, safeH);

        // Door swing overlay text
        if (this.doorState === 'open') {
            let titleSize = Math.min(40, W * 0.07);
            ctx.font = `bold ${titleSize}px 'Inter', sans-serif`;
            ctx.textAlign = 'center';
            ctx.shadowBlur = 20;
            ctx.shadowColor = '#FFD700';
            ctx.fillStyle = '#FFD700';
            ctx.fillText('🎉 ЗЛАМАНО!', W / 2, H * 0.42);
            ctx.shadowBlur = 0;

            let subSize = Math.min(20, W * 0.035);
            ctx.font = `600 ${subSize}px 'Inter', sans-serif`;
            ctx.fillStyle = '#ffffff';

            let timeBonus = Math.max(0, Math.floor(30 - this.safeTimer));
            let streakBonus = this.perfectStreak * 5;
            ctx.fillText(`+100 очків | ⏱+${timeBonus} | 🔥+${streakBonus}`, W / 2, H * 0.52);

            if (this.safeTimer <= this.safeBestTime) {
                ctx.fillStyle = '#00f2fe';
                let recSize = Math.min(16, W * 0.028);
                ctx.font = `${recSize}px 'Inter', sans-serif`;
                ctx.fillText(`⚡ Найкращий час: ${this.safeTimer.toFixed(1)}с`, W / 2, H * 0.59);
            }
        }
    }

    // ========================================================================
    // SPARKS & REWARD PARTICLES
    // ========================================================================
    _drawSparks(ctx) {
        for (let p of this.sparks) {
            ctx.globalAlpha = Math.max(0, p.life);
            ctx.fillStyle = p.color;
            ctx.shadowBlur = 6;
            ctx.shadowColor = p.color;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
    }

    _drawRewardParticles(ctx) {
        for (let p of this.rewardParticles) {
            ctx.globalAlpha = Math.max(0, p.life);
            ctx.fillStyle = p.color;

            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(p.rotation);

            // Star shape
            let s = p.size * (0.5 + p.life * 0.5);
            ctx.beginPath();
            for (let i = 0; i < 5; i++) {
                let angle = (i * 4 * Math.PI) / 5 - Math.PI / 2;
                let r = i === 0 ? s : s;
                if (i === 0) ctx.moveTo(Math.cos(angle) * r, Math.sin(angle) * r);
                else ctx.lineTo(Math.cos(angle) * r, Math.sin(angle) * r);
            }
            ctx.closePath();
            ctx.fill();

            ctx.restore();
        }
        ctx.globalAlpha = 1;
    }

    // ========================================================================
    // STOP
    // ========================================================================
    stop() {
        this.sparks = [];
        this.rewardParticles = [];
    }
};
