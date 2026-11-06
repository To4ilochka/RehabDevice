window.RehabGames = window.RehabGames || {};

window.RehabGames.safecracker = class SafeCrackerGame {
    constructor(ctx, api) {
        this.ctx = ctx;
        this.api = api;
        this.width = 1;
        this.height = 1;
        this.active = false;
        this.calibMin = -20;
        this.calibMax = 20;
        this.lastAngle = null;
        this.continuousAngle = 0;
        this.dialPosition = 0.5;
        this.dialDisplay = 0.5;
        this.score = 0;
        this.safesOpened = 0;
        this.step = 0;
        this.comboLength = 2;
        this.zoneWidth = 0.15;
        this.holdRequired = 1.5;
        this.holdProgress = 0;
        this.targets = [];
        this.state = 'locked';
        this.stateTime = 0;
        this.safeTime = 0;
        this.bestTime = Infinity;
        this.particles = [];
        this._lastScoreText = '';
        this._lastStateText = '';
    }

    init(canvas, options) {
        options = options || {};
        this.ctx = canvas.getContext('2d');
        this.width = Math.max(1, canvas.clientWidth || canvas.width);
        this.height = Math.max(1, canvas.clientHeight || canvas.height);
        this.calibMin = Number.isFinite(options.calibMin) ? options.calibMin : -20;
        this.calibMax = Number.isFinite(options.calibMax) ? options.calibMax : 20;
        if (this.calibMax <= this.calibMin) {
            this.calibMin = -20;
            this.calibMax = 20;
        }
        this.difficulty = options.difficulty || 'auto';
        this.active = true;
        this.lastAngle = null;
        this.continuousAngle = 0;
        this.score = 0;
        this.safesOpened = 0;
        this.bestTime = Infinity;
        this.particles = [];
        this._setDifficulty();
        this._newSafe();
        this._updateHud();
    }

    resize(width, height) {
        this.width = Math.max(1, width);
        this.height = Math.max(1, height);
    }

    _setDifficulty() {
        const progress = this.difficulty === 'auto' ? Math.min(1, this.safesOpened / 20) : 0;
        this.zoneWidth = this.difficulty === 'hard' ? 0.06 :
            this.difficulty === 'medium' ? 0.10 :
                this.difficulty === 'easy' ? 0.16 : 0.15 - progress * 0.08;
        this.holdRequired = this.difficulty === 'hard' ? 2.5 :
            this.difficulty === 'medium' ? 2 :
                this.difficulty === 'easy' ? 1.5 : 1.5 + progress * 1.5;
        this.comboLength = this.difficulty === 'hard' ? 4 :
            this.difficulty === 'medium' ? 3 :
                this.difficulty === 'easy' ? 2 : Math.min(5, 2 + Math.floor(this.safesOpened / 4));
    }

    _newSafe() {
        this.step = 0;
        this.holdProgress = 0;
        this.safeTime = 0;
        this.stateTime = 0;
        this.state = 'locked';
        this.targets = [];
        for (let index = 0; index < this.comboLength; index++) {
            let target = 0.1 + Math.random() * 0.8;
            let tries = 0;
            while (this.targets.some(value => Math.abs(value - target) < 0.15) && tries++ < 12) {
                target = 0.1 + Math.random() * 0.8;
            }
            this.targets.push(target);
        }
    }

    update(angle, dt) {
        if (!this.active) return;
        dt = Number.isFinite(dt) ? Math.min(0.1, Math.max(0, dt)) : 0;
        if (Number.isFinite(angle)) {
            if (this.lastAngle === null) {
                const center = (this.calibMin + this.calibMax) / 2;
                this.continuousAngle = angle >= -180 && angle <= 180
                    ? angle + 360 * Math.round((center - angle) / 360)
                    : angle;
            } else {
                const bothNormalized = Math.abs(this.lastAngle) <= 180 && Math.abs(angle) <= 180;
                let delta = angle - this.lastAngle;
                if (bothNormalized) delta = ((delta + 180) % 360 + 360) % 360 - 180;
                this.continuousAngle += delta;
            }
            this.lastAngle = angle;
        }

        let boundsChanged = false;
        if (this.continuousAngle > this.calibMax) {
            this.calibMax += (this.continuousAngle - this.calibMax) * 0.05;
            boundsChanged = true;
        }
        if (this.continuousAngle < this.calibMin) {
            this.calibMin -= (this.calibMin - this.continuousAngle) * 0.05;
            boundsChanged = true;
        }
        if (boundsChanged) this.api.updateCalibration(this.calibMin, this.calibMax);

        const range = this.calibMax - this.calibMin;
        this.dialPosition = range > 0
            ? Math.max(0, Math.min(1, (this.continuousAngle - this.calibMin) / range))
            : 0.5;
        this.dialDisplay += (this.dialPosition - this.dialDisplay) * (1 - Math.exp(-12 * dt));

        for (let index = this.particles.length - 1; index >= 0; index--) {
            const particle = this.particles[index];
            particle.life -= dt;
            particle.x += particle.vx * dt;
            particle.y += particle.vy * dt;
            particle.vy += 90 * dt;
            if (particle.life <= 0) this.particles.splice(index, 1);
        }

        if (this.state === 'locked') {
            this.safeTime += dt;
            const inZone = Math.abs(this.dialPosition - this.targets[this.step]) <= this.zoneWidth / 2;
            this.holdProgress = inZone
                ? Math.min(1, this.holdProgress + dt / this.holdRequired)
                : Math.max(0, this.holdProgress - dt * 0.8);
            if (this.holdProgress >= 1) {
                this.holdProgress = 0;
                this._burst();
                this.step++;
                if (this.step >= this.targets.length) {
                    this.state = 'opening';
                    this.stateTime = 0;
                }
            }
        } else {
            this.stateTime += dt;
            if (this.state === 'opening' && this.stateTime >= 1) {
                this.state = 'open';
                this.stateTime = 0;
                this.safesOpened++;
                this.bestTime = Math.min(this.bestTime, this.safeTime);
                this.score += 100 + Math.max(0, Math.floor(30 - this.safeTime));
                this._setDifficulty();
                this._burst(36);
            } else if (this.state === 'open' && this.stateTime >= 2.5) {
                this._newSafe();
            }
        }
        this._updateHud();
    }

    _burst(count = 14) {
        for (let index = 0; index < count; index++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 25 + Math.random() * 100;
            this.particles.push({
                x: this.width / 2,
                y: this.height * 0.48,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed - 25,
                life: 0.7 + Math.random() * 0.8,
                color: index % 2 ? '#00e676' : '#ffd54f'
            });
        }
    }

    _updateHud() {
        const scoreText = `Сейфів відкрито: ${this.safesOpened} | Очки: ${this.score}`;
        const stateText = this.state === 'locked'
            ? `Крок ${this.step + 1}/${this.targets.length} | Рівень: ${Math.min(10, 1 + Math.floor(this.safesOpened / 2))}`
            : this.state === 'open' ? 'Сейф відкрито!' : 'Відкриваємо сейф...';
        if (scoreText !== this._lastScoreText) {
            this.api.updateHUD('hudScore', scoreText);
            this._lastScoreText = scoreText;
        }
        if (stateText !== this._lastStateText) {
            this.api.updateHUD('hudBotState', stateText);
            this._lastStateText = stateText;
        }
    }

    draw(ctx) {
        if (!this.active) return;
        const width = this.width;
        const height = this.height;
        const centerX = width / 2;
        const centerY = height * 0.51;
        const radius = Math.max(36, Math.min(width * 0.22, height * 0.23));

        ctx.save();
        const background = ctx.createLinearGradient(0, 0, width, height);
        background.addColorStop(0, '#101b26');
        background.addColorStop(1, '#172b32');
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, width, height);

        const safeWidth = Math.min(width * 0.78, 440);
        const safeHeight = Math.min(height * 0.68, 440);
        const safeX = centerX - safeWidth / 2;
        const safeY = height * 0.16;
        ctx.fillStyle = '#354a52';
        this._roundedRect(ctx, safeX, safeY, safeWidth, safeHeight, 12);
        ctx.fill();
        ctx.strokeStyle = '#78909c';
        ctx.lineWidth = 3;
        ctx.stroke();

        ctx.fillStyle = '#cfd8dc';
        ctx.font = `600 ${Math.max(12, Math.min(18, width * 0.04))}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText('СЕЙФ', centerX, safeY + 27);

        ctx.fillStyle = '#15232a';
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius + 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#90a4ae';
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
        ctx.stroke();

        const start = -Math.PI * 0.75;
        const sweep = Math.PI * 1.5;
        if (this.state === 'locked') {
            const target = this.targets[this.step];
            const halfZone = this.zoneWidth / 2;
            ctx.strokeStyle = '#ffca28';
            ctx.lineWidth = 10;
            ctx.beginPath();
            ctx.arc(centerX, centerY, radius - 7,
                start + (target - halfZone) * sweep - Math.PI / 2,
                start + (target + halfZone) * sweep - Math.PI / 2);
            ctx.stroke();
        }

        for (let index = 0; index <= 10; index++) {
            const tickAngle = start + (index / 10) * sweep - Math.PI / 2;
            ctx.strokeStyle = index % 5 === 0 ? '#cfd8dc' : '#78909c';
            ctx.lineWidth = index % 5 === 0 ? 2 : 1;
            ctx.beginPath();
            ctx.moveTo(centerX + Math.cos(tickAngle) * (radius - 14), centerY + Math.sin(tickAngle) * (radius - 14));
            ctx.lineTo(centerX + Math.cos(tickAngle) * (radius - 4), centerY + Math.sin(tickAngle) * (radius - 4));
            ctx.stroke();
        }

        const needleAngle = start + this.dialDisplay * sweep - Math.PI / 2;
        ctx.strokeStyle = '#ff7043';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(centerX, centerY);
        ctx.lineTo(centerX + Math.cos(needleAngle) * (radius - 18), centerY + Math.sin(needleAngle) * (radius - 18));
        ctx.stroke();
        ctx.fillStyle = '#eceff1';
        ctx.beginPath();
        ctx.arc(centerX, centerY, 7, 0, Math.PI * 2);
        ctx.fill();

        if (this.state === 'locked') {
            const barWidth = Math.min(width * 0.56, 260);
            const barX = centerX - barWidth / 2;
            const barY = Math.min(height * 0.82, safeY + safeHeight - 18);
            ctx.fillStyle = '#17232a';
            this._roundedRect(ctx, barX, barY, barWidth, 12, 6);
            ctx.fill();
            ctx.fillStyle = '#00e676';
            this._roundedRect(ctx, barX, barY, barWidth * this.holdProgress, 12, 6);
            ctx.fill();
            ctx.fillStyle = '#ffffff';
            ctx.font = `500 ${Math.max(12, Math.min(16, width * 0.04))}px sans-serif`;
            ctx.fillText(this.holdProgress > 0 ? 'Утримуйте в зоні' : 'Наведіть на зону', centerX, barY - 8);
        } else if (this.state === 'open') {
            ctx.fillStyle = '#ffd54f';
            ctx.font = `700 ${Math.max(18, Math.min(32, width * 0.075))}px sans-serif`;
            ctx.fillText('Сейф відкрито!', centerX, height * 0.82);
            ctx.fillStyle = '#ffffff';
            ctx.font = `500 ${Math.max(13, Math.min(18, width * 0.045))}px sans-serif`;
            ctx.fillText(`Час: ${this.safeTime.toFixed(1)} с | Найкращий: ${this.bestTime.toFixed(1)} с`, centerX, height * 0.88);
        }

        ctx.fillStyle = '#ffffff';
        ctx.font = `600 ${Math.max(13, Math.min(18, width * 0.045))}px sans-serif`;
        ctx.fillText(this.state === 'locked' ? `Комбінація ${this.step + 1} з ${this.comboLength}` : 'Комбінацію завершено', centerX, height * 0.12);

        for (const particle of this.particles) {
            ctx.globalAlpha = Math.max(0, particle.life);
            ctx.fillStyle = particle.color;
            ctx.beginPath();
            ctx.arc(particle.x, particle.y, 3, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
        ctx.restore();
    }

    _roundedRect(ctx, x, y, width, height, radius) {
        ctx.beginPath();
        if (ctx.roundRect) {
            ctx.roundRect(x, y, width, height, radius);
        } else {
            ctx.rect(x, y, width, height);
        }
    }

    stop() {
        this.active = false;
        this.particles.length = 0;
        this.api.updateHUD('hudScore', '');
        this.api.updateHUD('hudBotState', '');
        this._lastScoreText = '';
        this._lastStateText = '';
    }
};