// ============================================================================
// ⚖️ BalanceBoard — Гра на баланс для реабілітації кисті (Збалансована Фізика)
// RehabDevice IoT System | MPU6050/MPU6500 Sensor Control
// ============================================================================

window.RehabGames = window.RehabGames || {};

window.RehabGames['balanceboard'] = class BalanceBoardGame {
    constructor(ctx, api) {
        this.ctx = ctx;
        this.api = api;

        // Калібрування та налаштування
        this.calibMin = -20;
        this.calibMax = 20;
        this.difficulty = 'auto';

        // Розміри
        this.width = ctx.canvas.width;
        this.height = ctx.canvas.height;

        // Стан гри
        this.isActive = false;
        this.gameOver = false;
        this.survivalTime = 0;
        this.bestTime = 0;
        this.roundNumber = 0;

        // Ньютонівська фізика платформи та робота
        this.boardTilt = 0;             
        this.robotX = 0;                
        this.robotVelocity = 0;         
        
        this.windForce = 0;             
        this.waveTime = 0;
        this.gustTimer = 0;
        this.gustForce = 0;
        this.gustDuration = 0;
        this.currentGustTime = 0;
        
        this.difficultyLevel = 1;       

        // Анімації персонажа
        this.charArmAngle = 0;          
        this.charBodyTilt = 0;          
        this.charSquish = 1;            
        this.charEyeScale = 1;          
        this.charFalling = false;
        this.charFallVelocity = 0;
        this.charFallRotation = 0;
        this.charBlink = 0;
        this.charBlinkTimer = 0;

        // Ефекти
        this.particles = [];
        this.sparkTimer = 0;
        this.stars = [];
        this.auroraPhase = 0;

        // Індикатори
        this.dangerLevel = 0;           
        this.dangerPulse = 0;
        this.comboMultiplier = 1;
        this.steadyTimer = 0;           

        // Пост-ефекти
        this.shakeX = 0;
        this.shakeY = 0;
        this.shakeIntensity = 0;
        this.postFallTimer = 0;
        this.POST_FALL_DURATION = 2.5;
    }

    init(canvas, options) {
        options = options || {};
        this.ctx = canvas.getContext("2d");
        this.calibMin = Number.isFinite(options.calibMin) ? options.calibMin : -20;
        this.calibMax = Number.isFinite(options.calibMax) ? options.calibMax : 20;
        if (this.calibMax <= this.calibMin) {
            this.calibMin = -20;
            this.calibMax = 20;
        }
        this.difficulty = options.difficulty || 'auto';

        this.resize(canvas.clientWidth || canvas.width, canvas.clientHeight || canvas.height);
        this._initStars();
        this._resetRound();
        this.updateHUD();
    }

    resize(width, height) {
        this.width = Math.max(1, Number(width) || 1);
        this.height = Math.max(1, Number(height) || 1);
    }

    _resetRound() {
        this.isActive = true;
        this.gameOver = false;
        this.survivalTime = 0;
        this.roundNumber++;
        
        this.boardTilt = 0;
        this.robotX = 0;
        this.robotVelocity = 0;
        
        this.windForce = 0;
        this.waveTime = 0;
        this.gustTimer = 5; 
        this.gustForce = 0;
        this.gustDuration = 0;
        this.difficultyLevel = 1;
        
        this.charFalling = false;
        this.charFallVelocity = 0;
        this.charFallRotation = 0;
        this.charSquish = 1;
        this.charEyeScale = 1;
        
        this.comboMultiplier = 1;
        this.steadyTimer = 0;
        this.particles = [];
        this.shakeIntensity = 0;
        this.postFallTimer = 0;
        this.dangerLevel = 0;
    }

    _initStars() {
        this.stars = [];
        for (let i = 0; i < 120; i++) {
            this.stars.push({
                x: Math.random(),
                y: Math.random() * 0.7,
                size: 0.5 + Math.random() * 2,
                brightness: 0.3 + Math.random() * 0.7,
                twinkleSpeed: 0.5 + Math.random() * 3,
                twinklePhase: Math.random() * Math.PI * 2
            });
        }
    }

    update(currentAngle, dt) {
        if (!Number.isFinite(dt) || dt < 0 || dt > 0.1) dt = 0.016;

        const safeAngle = Number.isFinite(currentAngle) ? currentAngle : (this.calibMin + this.calibMax) / 2;
        let boundsChanged = false;
        if (Number.isFinite(currentAngle)) {
            if (currentAngle > this.calibMax) {
                this.calibMax += (currentAngle - this.calibMax) * 0.08;
                boundsChanged = true;
            }
            if (currentAngle < this.calibMin) {
                this.calibMin -= (this.calibMin - currentAngle) * 0.08;
                boundsChanged = true;
            }
        }
        if (boundsChanged) this.api.updateCalibration(this.calibMin, this.calibMax);

        this.auroraPhase += dt * 0.3;
        this.charBlinkTimer -= dt;
        if (this.charBlinkTimer <= 0) {
            this.charBlink = 1;
            this.charBlinkTimer = 2 + Math.random() * 4;
        }
        if (this.charBlink > 0) {
            this.charBlink -= dt * 8;
            if (this.charBlink < 0) this.charBlink = 0;
        }

        this.shakeIntensity *= Math.pow(0.05, dt);
        if (this.shakeIntensity < 0.3) this.shakeIntensity = 0;
        this.shakeX = (Math.random() - 0.5) * this.shakeIntensity;
        this.shakeY = (Math.random() - 0.5) * this.shakeIntensity;

        this._updateParticles(dt);

        if (this.gameOver) {
            this.postFallTimer += dt;
            if (this.charFalling) {
                this.charFallVelocity += 1200 * dt; 
                this.robotX += this.charFallVelocity * Math.sin(this.charFallRotation) * dt;
                this.charFallRotation += 3 * dt;
                if (this.charFallVelocity > 2000) this.charFalling = false;
            }
            if (this.postFallTimer > this.POST_FALL_DURATION) {
                this._resetRound();
            }
            return;
        }

        this.survivalTime += dt;
        this.difficultyLevel = Math.min(10, 1 + this.survivalTime / 20); 

        let range = this.calibMax - this.calibMin;
        let normalized = range > 0 ? (safeAngle - this.calibMin) / range : 0.5;
        if (!Number.isFinite(normalized)) normalized = 0.5;
        normalized = Math.max(0, Math.min(1, normalized));
        
        let maxBoardTilt = 22; 
        let targetBoardTilt = (normalized - 0.5) * 2 * maxBoardTilt;
        
        this.boardTilt += (targetBoardTilt - this.boardTilt) * 12 * dt;

        let windBase = 250 + (this.difficultyLevel * 40); 
        this.waveTime += dt;

        let wave1 = Math.sin(this.waveTime * 0.5) * windBase;
        let wave2 = Math.sin(this.waveTime * 1.2) * windBase * 0.3;
        let wave3 = Math.sin(this.waveTime * 0.2) * windBase * 0.5;
        this.windForce = wave1 + wave2 + wave3;

        this.gustTimer -= dt;
        if (this.gustTimer <= 0) {
            this.gustForce = (Math.random() > 0.5 ? 1 : -1) * (windBase * (0.8 + Math.random() * 0.5));
            this.gustDuration = 1.0 + Math.random() * 1.0; 
            this.currentGustTime = 0;
            this.gustTimer = 4 + Math.random() * 5; 
        }

        if (this.gustDuration > 0) {
            this.currentGustTime += dt;
            let progress = this.currentGustTime / this.gustDuration;
            this.windForce += this.gustForce * Math.sin(progress * Math.PI);
            if (this.currentGustTime >= this.gustDuration) {
                this.gustDuration = 0;
            }
        }

        if (Math.abs(this.windForce) > 600 && Math.random() > 0.7) {
            this._spawnWindLines();
        }

        let gravityForce = 2200 * Math.sin(this.boardTilt * Math.PI / 180);
        let acceleration = gravityForce + this.windForce;

        this.robotVelocity += acceleration * dt;
        this.robotVelocity -= this.robotVelocity * 5.5 * dt; 
        this.robotX += this.robotVelocity * dt;

        let platW = this.width * 0.55;
        let edgeDist = Math.max(1, platW / 2 - 8); 
        
        this.dangerLevel = Math.min(1, Math.abs(this.robotX) / edgeDist);
        this.dangerPulse += dt * (3 + this.dangerLevel * 10);

        let targetBodyTilt = (this.robotVelocity * 0.04) - (this.boardTilt * 0.4);
        this.charBodyTilt += (targetBodyTilt - this.charBodyTilt) * 10 * dt;

        let targetArmAngle = -this.robotVelocity * 0.08 - (this.boardTilt * 0.8);
        this.charArmAngle += (targetArmAngle - this.charArmAngle) * 8 * dt;

        let targetEyeScale = 1 + this.dangerLevel * 1.2;
        this.charEyeScale += (targetEyeScale - this.charEyeScale) * 5 * dt;

        let targetSquish = 1 - this.dangerLevel * 0.2;
        this.charSquish += (targetSquish - this.charSquish) * 8 * dt;

        if (Math.abs(this.robotX) < edgeDist * 0.3) { 
            this.steadyTimer += dt;
            if (this.steadyTimer > 2) {
                this.comboMultiplier = Math.min(5, 1 + Math.floor(this.steadyTimer / 2.5));
            }
            this.sparkTimer -= dt;
            if (this.sparkTimer <= 0) {
                this._spawnBalanceSparks();
                this.sparkTimer = 0.3;
            }
        } else {
            this.steadyTimer = Math.max(0, this.steadyTimer - dt * 3);
            this.comboMultiplier = 1;
        }

        if (this.dangerLevel > 0.8) {
            this.shakeIntensity = Math.max(this.shakeIntensity, this.dangerLevel * 5);
        }

        if (Math.abs(this.robotX) > edgeDist) {
            this._triggerFall();
        }

        this.updateHUD();
    }

    _triggerFall() {
        this.gameOver = true;
        this.isActive = false;
        this.charFalling = true;
        
        this.charFallVelocity = -150;
        this.charFallRotation = (this.robotX > 0 ? 1 : -1) * 1.5;
        this.postFallTimer = 0;

        if (this.survivalTime > this.bestTime) {
            this.bestTime = this.survivalTime;
        }

        this.shakeIntensity = 15;

        let cx = this.width / 2 + this.robotX;
        let cy = this.height * 0.6;
        for (let i = 0; i < 40; i++) {
            let angle = Math.random() * Math.PI * 2;
            let speed = 100 + Math.random() * 250;
            this.particles.push({
                x: cx, y: cy,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed - 150,
                life: 1,
                maxLife: 1,
                size: 3 + Math.random() * 6,
                color: Math.random() > 0.5 ? '#ff1744' : '#ff9100',
                gravity: 400,
                type: 'explosion'
            });
        }

        this.api.updateHUD("hudBotState", `💥 Падіння! Рекорд: ${this.bestTime.toFixed(1)}с`);
    }

    _spawnBalanceSparks() {
        let cx = this.width / 2;
        let pivotY = this.height * 0.64;
        
        let angleRad = this.boardTilt * Math.PI / 180;
        let screenX = cx + Math.cos(angleRad) * this.robotX;
        let screenY = pivotY - this.height * 0.028 / 2 + Math.sin(angleRad) * this.robotX;

        for (let i = 0; i < 3; i++) {
            this.particles.push({
                x: screenX + (Math.random() - 0.5) * 40,
                y: screenY + (Math.random() - 0.5) * 20,
                vx: (Math.random() - 0.5) * 60,
                vy: -40 - Math.random() * 50,
                life: 1,
                maxLife: 1,
                size: 1.5 + Math.random() * 2.5,
                color: this.comboMultiplier >= 3 ? '#00f2fe' : '#00e676',
                gravity: -10,
                type: 'spark'
            });
        }
    }

    _spawnWindLines() {
        let isLeft = this.windForce > 0; 
        let startX = isLeft ? -50 : this.width + 50;
        let speed = (isLeft ? 1 : -1) * (800 + Math.random() * 400); 
        
        this.particles.push({
            x: startX,
            y: this.height * 0.2 + Math.random() * this.height * 0.5,
            vx: speed,
            vy: 0,
            life: 0.5,
            maxLife: 0.5,
            size: 2,
            color: 'rgba(255, 255, 255, 0.4)',
            gravity: 0,
            type: 'wind'
        });
    }

    _updateParticles(dt) {
        for (let i = this.particles.length - 1; i >= 0; i--) {
            let p = this.particles[i];
            p.life -= dt / p.maxLife;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.vy += (p.gravity || 0) * dt;
            if (p.life <= 0) {
                this.particles.splice(i, 1);
            }
        }
    }

    updateHUD() {
        let minutes = Math.floor(this.survivalTime / 60);
        let seconds = Math.floor(this.survivalTime % 60);
        let timeStr = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        let comboStr = this.comboMultiplier > 1 ? ` (x${Math.floor(this.comboMultiplier)})` : '';
        this.api.updateHUD("hudScore", `⏱ Час: ${timeStr}${comboStr}`);

        if (!this.gameOver) {
            let levelIcon = this.difficultyLevel < 4 ? '🍃' : this.difficultyLevel < 7 ? '💨' : '🌪️';
            this.api.updateHUD("hudBotState", `${levelIcon} Сила шторму: ${Math.floor(this.difficultyLevel)}/10`);
        }
    }

    // === Відмальовка частинок ефектів ===
    _drawParticles(ctx) {
        for (let p of this.particles) {
            ctx.globalAlpha = Math.max(0, p.life);
            ctx.fillStyle = p.color;

            if (p.type === 'wind') {
                ctx.fillRect(p.x, p.y, p.size * 15, p.size);
            } else if (p.type === 'spark') {
                ctx.shadowBlur = 6;
                ctx.shadowColor = p.color;
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
                ctx.fill();
                ctx.shadowBlur = 0;
            } else {
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.size * (0.3 + p.life * 0.7), 0, Math.PI * 2);
                ctx.fill();
            }
        }
        ctx.globalAlpha = 1;
    }

    draw(ctx) {
        const W = this.width;
        const H = this.height;

        ctx.save();
        ctx.translate(this.shakeX, this.shakeY);

        this._drawBackground(ctx, W, H);
        this._drawAurora(ctx, W, H);
        this._drawMountains(ctx, W, H);
        this._drawFulcrum(ctx, W, H);

        let cx = W / 2;
        let pivotY = H * 0.64;
        let platW = W * 0.55;
        let platH = H * 0.028;
        let angleRad = this.boardTilt * Math.PI / 180;

        ctx.save();
        ctx.translate(cx, pivotY);
        ctx.rotate(angleRad);

        this._drawPlatform(ctx, platW, platH);

        if (!this.charFalling) {
            ctx.save();
            ctx.translate(this.robotX, -platH / 2); 
            this._drawCharacter(ctx, W, H);
            ctx.restore();
        }
        ctx.restore(); 

        if (this.charFalling) {
            ctx.save();
            ctx.translate(cx + this.robotX, pivotY + this.charFallVelocity * 0.1); 
            ctx.rotate(this.charFallRotation);
            this._drawCharacter(ctx, W, H);
            ctx.restore();
        }

        // Виклик відмальовки частинок
        this._drawParticles(ctx);
        
        this._drawDangerVignette(ctx, W, H);

        if (this.gameOver && !this.charFalling) {
            this._drawGameOverOverlay(ctx, W, H);
        }

        ctx.restore();
    }

    _drawBackground(ctx, W, H) {
        let grad = ctx.createLinearGradient(0, 0, 0, H);
        grad.addColorStop(0, '#050a18');
        grad.addColorStop(0.3, '#0a1628');
        grad.addColorStop(0.6, '#0f1f3a');
        grad.addColorStop(1, '#1a2744');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, H);

        let time = performance.now() / 1000;
        for (let s of this.stars) {
            let twinkle = 0.5 + 0.5 * Math.sin(time * s.twinkleSpeed + s.twinklePhase);
            let alpha = s.brightness * twinkle;
            ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
            ctx.beginPath();
            ctx.arc(s.x * W, s.y * H, s.size, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    _drawAurora(ctx, W, H) {
        ctx.save();
        ctx.globalAlpha = 0.12;
        ctx.globalCompositeOperation = 'screen';

        for (let i = 0; i < 3; i++) {
            let auroraGrad = ctx.createLinearGradient(0, H * 0.05, 0, H * 0.35);
            let hue = 140 + i * 40 + Math.sin(this.auroraPhase + i) * 20;
            auroraGrad.addColorStop(0, `hsla(${hue}, 80%, 60%, 0)`);
            auroraGrad.addColorStop(0.5, `hsla(${hue}, 80%, 60%, 0.6)`);
            auroraGrad.addColorStop(1, `hsla(${hue}, 80%, 60%, 0)`);

            ctx.beginPath();
            ctx.moveTo(0, H * 0.1);
            for (let x = 0; x <= W; x += 20) {
                let y = H * 0.15 + Math.sin(x / W * 4 + this.auroraPhase * (1 + i * 0.3)) * H * 0.06
                      + Math.sin(x / W * 7 + this.auroraPhase * 0.7) * H * 0.03;
                ctx.lineTo(x, y + i * H * 0.04);
            }
            ctx.lineTo(W, H * 0.35);
            ctx.lineTo(0, H * 0.35);
            ctx.closePath();
            ctx.fillStyle = auroraGrad;
            ctx.fill();
        }
        ctx.restore();
    }

    _drawMountains(ctx, W, H) {
        ctx.fillStyle = '#0d1520';
        ctx.beginPath();
        ctx.moveTo(0, H * 0.7);
        ctx.lineTo(W * 0.1, H * 0.55);
        ctx.lineTo(W * 0.2, H * 0.6);
        ctx.lineTo(W * 0.35, H * 0.45);
        ctx.lineTo(W * 0.45, H * 0.52);
        ctx.lineTo(W * 0.55, H * 0.42);
        ctx.lineTo(W * 0.65, H * 0.5);
        ctx.lineTo(W * 0.75, H * 0.38);
        ctx.lineTo(W * 0.85, H * 0.48);
        ctx.lineTo(W * 0.95, H * 0.44);
        ctx.lineTo(W, H * 0.55);
        ctx.lineTo(W, H);
        ctx.lineTo(0, H);
        ctx.closePath();
        ctx.fill();

        ctx.strokeStyle = 'rgba(200, 220, 255, 0.08)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(W * 0.35, H * 0.45);
        ctx.lineTo(W * 0.55, H * 0.42);
        ctx.lineTo(W * 0.75, H * 0.38);
        ctx.stroke();
    }

    _drawFulcrum(ctx, W, H) {
        let cx = W / 2;
        let baseY = H * 0.72;
        let triH = H * 0.08;
        let triW = W * 0.06;

        let fulcrumGrad = ctx.createLinearGradient(cx, baseY - triH, cx, baseY);
        fulcrumGrad.addColorStop(0, '#4a5568');
        fulcrumGrad.addColorStop(1, '#2d3748');

        ctx.fillStyle = fulcrumGrad;
        ctx.beginPath();
        ctx.moveTo(cx, baseY - triH);
        ctx.lineTo(cx - triW, baseY);
        ctx.lineTo(cx + triW, baseY);
        ctx.closePath();
        ctx.fill();

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(cx - triW + 2, baseY);
        ctx.lineTo(cx, baseY - triH + 2);
        ctx.lineTo(cx + triW - 2, baseY);
        ctx.stroke();
    }

    _drawPlatform(ctx, platW, platH) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
        ctx.fillRect(-platW / 2, platH * 0.5, platW, platH * 0.8);

        let platGrad = ctx.createLinearGradient(-platW / 2, -platH, platW / 2, platH);
        platGrad.addColorStop(0, '#5D4037');
        platGrad.addColorStop(0.3, '#795548');
        platGrad.addColorStop(0.5, '#8D6E63');
        platGrad.addColorStop(0.7, '#795548');
        platGrad.addColorStop(1, '#5D4037');

        ctx.fillStyle = platGrad;
        if (ctx.roundRect) {
            ctx.beginPath();
            ctx.roundRect(-platW / 2, -platH / 2, platW, platH, 4);
            ctx.fill();
        } else {
            ctx.fillRect(-platW / 2, -platH / 2, platW, platH);
        }

        ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
        ctx.fillRect(-platW / 2 + 4, -platH / 2, platW - 8, platH * 0.3);

        ctx.strokeStyle = 'rgba(0, 0, 0, 0.15)';
        ctx.lineWidth = 0.5;
        for (let i = 0; i < 8; i++) {
            let x = -platW / 2 + (platW / 8) * i + platW / 16;
            ctx.beginPath();
            ctx.moveTo(x, -platH / 2 + 2);
            ctx.lineTo(x, platH / 2 - 2);
            ctx.stroke();
        }

        ctx.fillStyle = '#90A4AE';
        ctx.fillRect(-platW / 2, -platH / 2 - 1, 6, platH + 2);
        ctx.fillRect(platW / 2 - 6, -platH / 2 - 1, 6, platH + 2);

        if (this.dangerLevel > 0.3) {
            let glowAlpha = (this.dangerLevel - 0.3) * 1.4;
            let pulse = 0.6 + 0.4 * Math.sin(this.dangerPulse);
            ctx.shadowBlur = 15 * this.dangerLevel;
            ctx.shadowColor = this.dangerLevel > 0.7 ?
                `rgba(255, 23, 68, ${glowAlpha * pulse})` :
                `rgba(255, 145, 0, ${glowAlpha * pulse * 0.7})`;
            ctx.strokeStyle = this.dangerLevel > 0.7 ?
                `rgba(255, 23, 68, ${glowAlpha * 0.6})` :
                `rgba(255, 145, 0, ${glowAlpha * 0.4})`;
            ctx.lineWidth = 2;
            if (ctx.roundRect) {
                ctx.beginPath();
                ctx.roundRect(-platW / 2, -platH / 2, platW, platH, 4);
                ctx.stroke();
            }
            ctx.shadowBlur = 0;
        }
    }

    _drawCharacter(ctx, W, H) {
        ctx.rotate(this.charBodyTilt * Math.PI / 180 * 0.3);
        ctx.scale(1, this.charSquish);

        let scale = Math.min(W, H) / 500;
        if (scale < 0.5) scale = 0.5;
        if (scale > 2) scale = 2;

        let legSpread = 12 * scale;
        let legH = 22 * scale;
        let legW = 7 * scale;

        ctx.fillStyle = '#37474F';
        ctx.fillRect(-legSpread - legW / 2, -legH, legW, legH);
        ctx.fillRect(legSpread - legW / 2, -legH, legW, legH);

        ctx.fillStyle = '#546E7A';
        ctx.fillRect(-legSpread - legW / 2 - 2 * scale, -2 * scale, legW + 4 * scale, 4 * scale);
        ctx.fillRect(legSpread - legW / 2 - 2 * scale, -2 * scale, legW + 4 * scale, 4 * scale);

        let bodyW = 32 * scale;
        let bodyH = 36 * scale;
        let bodyY = -legH;

        let bodyGrad = ctx.createLinearGradient(0, bodyY - bodyH, 0, bodyY);
        bodyGrad.addColorStop(0, '#1565C0');
        bodyGrad.addColorStop(0.5, '#1976D2');
        bodyGrad.addColorStop(1, '#1565C0');
        ctx.fillStyle = bodyGrad;

        if (ctx.roundRect) {
            ctx.beginPath();
            ctx.roundRect(-bodyW / 2, bodyY - bodyH, bodyW, bodyH, 6 * scale);
            ctx.fill();
        } else {
            ctx.fillRect(-bodyW / 2, bodyY - bodyH, bodyW, bodyH);
        }

        let chestGlow = this.dangerLevel > 0.6 ?
            `rgba(255, 23, 68, ${0.6 + 0.4 * Math.sin(this.dangerPulse)})` :
            `rgba(0, 230, 118, ${0.5 + 0.3 * Math.sin(performance.now() / 500)})`;
        ctx.fillStyle = chestGlow;
        ctx.beginPath();
        ctx.arc(0, bodyY - bodyH * 0.55, 5 * scale, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 10 * scale;
        ctx.shadowColor = chestGlow;
        ctx.fill();
        ctx.shadowBlur = 0;

        let armLen = 28 * scale;
        let armW = 6 * scale;
        let shoulderY = bodyY - bodyH * 0.85;
        let armAngleRad = this.charArmAngle * Math.PI / 180;

        ctx.save();
        ctx.translate(-bodyW / 2, shoulderY);
        ctx.rotate(-0.4 + armAngleRad * 0.5);
        ctx.fillStyle = '#1976D2';
        ctx.fillRect(-armLen, -armW / 2, armLen, armW);
        ctx.fillStyle = '#90A4AE';
        ctx.beginPath();
        ctx.arc(-armLen, 0, armW * 0.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        ctx.save();
        ctx.translate(bodyW / 2, shoulderY);
        ctx.rotate(0.4 - armAngleRad * 0.5);
        ctx.fillStyle = '#1976D2';
        ctx.fillRect(0, -armW / 2, armLen, armW);
        ctx.fillStyle = '#90A4AE';
        ctx.beginPath();
        ctx.arc(armLen, 0, armW * 0.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        let headW = 26 * scale;
        let headH = 24 * scale;
        let headY = bodyY - bodyH;

        ctx.fillStyle = '#546E7A';
        ctx.fillRect(-4 * scale, headY - 3 * scale, 8 * scale, 6 * scale);

        let headGrad = ctx.createLinearGradient(0, headY - headH, 0, headY);
        headGrad.addColorStop(0, '#78909C');
        headGrad.addColorStop(1, '#546E7A');
        ctx.fillStyle = headGrad;

        if (ctx.roundRect) {
            ctx.beginPath();
            ctx.roundRect(-headW / 2, headY - headH, headW, headH, 8 * scale);
            ctx.fill();
        } else {
            ctx.fillRect(-headW / 2, headY - headH, headW, headH);
        }

        let visorW = headW * 0.75;
        let visorH = headH * 0.55;
        let visorY = headY - headH * 0.7;
        ctx.fillStyle = '#0a1628';
        if (ctx.roundRect) {
            ctx.beginPath();
            ctx.roundRect(-visorW / 2, visorY, visorW, visorH, 4 * scale);
            ctx.fill();
        } else {
            ctx.fillRect(-visorW / 2, visorY, visorW, visorH);
        }

        let eyeSize = 3.5 * scale * this.charEyeScale;
        let blinkSquish = 1 - this.charBlink * 0.9;
        let eyeY = visorY + visorH * 0.45;

        ctx.fillStyle = '#00f2fe';
        ctx.save();
        ctx.translate(-6 * scale, eyeY);
        ctx.scale(1, blinkSquish);
        ctx.beginPath();
        ctx.arc(0, 0, eyeSize, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        ctx.save();
        ctx.translate(6 * scale, eyeY);
        ctx.scale(1, blinkSquish);
        ctx.beginPath();
        ctx.arc(0, 0, eyeSize, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        ctx.shadowBlur = 8 * scale;
        ctx.shadowColor = '#00f2fe';
        ctx.fillStyle = 'rgba(0, 242, 254, 0.3)';
        ctx.beginPath();
        ctx.arc(-6 * scale, eyeY, eyeSize * 1.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(6 * scale, eyeY, eyeSize * 1.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;

        ctx.strokeStyle = '#90A4AE';
        ctx.lineWidth = 1.5 * scale;
        ctx.beginPath();
        ctx.moveTo(0, headY - headH);
        ctx.lineTo(0, headY - headH - 8 * scale);
        ctx.stroke();
        
        let isGustComing = this.gustTimer > 0 && this.gustTimer < 1.0;
        let antennaGlow = isGustComing ? (0.5 + 0.5 * Math.sin(performance.now() / 50)) : (0.5 + 0.5 * Math.sin(performance.now() / 300));
        ctx.fillStyle = isGustComing ? `rgba(255, 23, 68, ${antennaGlow})` : `rgba(0, 242, 254, ${antennaGlow})`;
        ctx.beginPath();
        ctx.arc(0, headY - headH - 10 * scale, (isGustComing ? 3.5 : 2.5) * scale, 0, Math.PI * 2);
        ctx.fill();
    }

    _drawDangerVignette(ctx, W, H) {
        if (this.dangerLevel < 0.3) return;

        let alpha = (this.dangerLevel - 0.3) * 0.5;
        let pulse = 0.7 + 0.3 * Math.sin(this.dangerPulse);
        alpha *= pulse;

        let color = this.dangerLevel > 0.7 ? `rgba(255, 23, 68, ${alpha})` : `rgba(255, 145, 0, ${alpha * 0.6})`;

        let vGrad = ctx.createLinearGradient(0, 0, 0, H * 0.15);
        vGrad.addColorStop(0, color);
        vGrad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = vGrad;
        ctx.fillRect(0, 0, W, H * 0.15);

        let vGrad2 = ctx.createLinearGradient(0, H * 0.85, 0, H);
        vGrad2.addColorStop(0, 'rgba(0,0,0,0)');
        vGrad2.addColorStop(1, color);
        ctx.fillStyle = vGrad2;
        ctx.fillRect(0, H * 0.85, W, H * 0.15);

        let hGrad = ctx.createLinearGradient(0, 0, W * 0.08, 0);
        hGrad.addColorStop(0, color);
        hGrad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = hGrad;
        ctx.fillRect(0, 0, W * 0.08, H);

        let hGrad2 = ctx.createLinearGradient(W * 0.92, 0, W, 0);
        hGrad2.addColorStop(0, 'rgba(0,0,0,0)');
        hGrad2.addColorStop(1, color);
        ctx.fillStyle = hGrad2;
        ctx.fillRect(W * 0.92, 0, W * 0.08, H);
    }

    _drawGameOverOverlay(ctx, W, H) {
        ctx.fillStyle = 'rgba(10, 14, 23, 0.7)';
        ctx.fillRect(0, 0, W, H);

        let titleSize = Math.min(48, W * 0.08);
        ctx.font = `bold ${titleSize}px 'Inter', sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        ctx.shadowBlur = 20;
        ctx.shadowColor = '#ff1744';
        ctx.fillStyle = '#ff1744';
        ctx.fillText('💥 Падіння!', W / 2, H * 0.35);
        ctx.shadowBlur = 0;

        let scoreSize = Math.min(28, W * 0.05);
        ctx.font = `600 ${scoreSize}px 'Inter', sans-serif`;
        ctx.fillStyle = '#ffffff';
        let minutes = Math.floor(this.survivalTime / 60);
        let seconds = Math.floor(this.survivalTime % 60);
        ctx.fillText(`⏱ Час: ${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`, W / 2, H * 0.45);

        ctx.fillStyle = '#00f2fe';
        let bestMin = Math.floor(this.bestTime / 60);
        let bestSec = Math.floor(this.bestTime % 60);
        ctx.fillText(`🏆 Рекорд: ${bestMin.toString().padStart(2, '0')}:${bestSec.toString().padStart(2, '0')}`, W / 2, H * 0.53);

        let hintAlpha = 0.5 + 0.5 * Math.sin(performance.now() / 400);
        let hintSize = Math.min(18, W * 0.035);
        ctx.font = `${hintSize}px 'Inter', sans-serif`;
        ctx.fillStyle = `rgba(148, 163, 184, ${hintAlpha})`;
        let remaining = Math.max(0, this.POST_FALL_DURATION - this.postFallTimer);
        ctx.fillText(`Новий раунд через ${remaining.toFixed(0)}с...`, W / 2, H * 0.63);
    }

    stop() {
        this.isActive = false;
        this.particles.length = 0;
        this.stars.length = 0;
    }
};
